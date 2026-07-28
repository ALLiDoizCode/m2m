//! A structured envelope (ADR 0018): what a packet carries between a
//! connector and the app behind it -- a method, a target, headers and a
//! body going in ([`EnvelopeRequest`]); a status, headers and a body coming
//! back ([`EnvelopeResponse`]). One shape, two directions, both encoded
//! with the same OER primitives an ILP packet already uses (`oer.rs`,
//! RFC-0030) rather than as HTTP text.
//!
//! The prototype carried an HTTP/1.1 request as latin1 text and hand-parsed
//! it, which is how it acquired leniencies nobody chose -- a missing
//! header/body separator silently yielding an empty body, blank header
//! lines skipped, spaces tolerated inside the target. A structured encoding
//! has exactly one representation per message and nothing to smuggle
//! (issue #519).
//!
//! Pure: no I/O, no keys, no clock. This is the module the seal (ADR
//! 0018's gift wrap) goes around later, and the one whose properties
//! generate the cross-repo vectors (ADR 0021) -- which is why its
//! invariants are proptest properties, not only worked examples.

use crate::oer::{
    decode_var_octet_string, decode_var_uint, encode_var_octet_string, encode_var_uint,
};
use thiserror::Error;

const TYPE_ENVELOPE_REQUEST: u8 = 1;
const TYPE_ENVELOPE_RESPONSE: u8 = 2;

/// Everything that can go wrong decoding a structured envelope. Every
/// variant is reachable and distinguishable from every other -- there is
/// no catch-all "invalid" case for a decoder to fall back to leniently.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum EnvelopeError {
    #[error("buffer underflow: envelope is truncated")]
    BufferUnderflow,

    #[error("invalid envelope type byte: expected 1 (REQUEST) or 2 (RESPONSE)")]
    InvalidType,

    #[error("invalid UTF-8 in envelope field '{0}'")]
    InvalidUtf8(&'static str),

    #[error("trailing bytes after a fully decoded envelope")]
    TrailingBytes,
}

/// Check the envelope type byte against `expected`, returning the number of
/// bytes consumed (always 1) so callers can fold it into their `offset`.
fn decode_type_byte(buf: &[u8], expected: u8) -> Result<usize, EnvelopeError> {
    let type_byte = *buf.first().ok_or(EnvelopeError::BufferUnderflow)?;
    if type_byte != expected {
        return Err(EnvelopeError::InvalidType);
    }
    Ok(1)
}

fn decode_utf8_field(bytes: Vec<u8>, field: &'static str) -> Result<String, EnvelopeError> {
    String::from_utf8(bytes).map_err(|_| EnvelopeError::InvalidUtf8(field))
}

/// Decode a var-octet-string field and validate it as UTF-8 in one step,
/// returning the string and the number of bytes consumed.
fn decode_string_field(
    buf: &[u8],
    offset: usize,
    field: &'static str,
) -> Result<(String, usize), EnvelopeError> {
    let (bytes, n) =
        decode_var_octet_string(buf, offset).map_err(|_| EnvelopeError::BufferUnderflow)?;
    Ok((decode_utf8_field(bytes, field)?, n))
}

/// Encode a header list as a count prefix followed by each `(name, value)`
/// pair in order -- a plain sequence, never a map, so that both header
/// order and duplicate header names survive a round trip.
fn encode_headers(headers: &[(String, String)]) -> Vec<u8> {
    let mut out = encode_var_uint(headers.len() as u64);
    for (name, value) in headers {
        out.extend(encode_var_octet_string(name.as_bytes()));
        out.extend(encode_var_octet_string(value.as_bytes()));
    }
    out
}

fn decode_headers(
    buf: &[u8],
    offset: usize,
) -> Result<(Vec<(String, String)>, usize), EnvelopeError> {
    let (count, n) = decode_var_uint(buf, offset).map_err(|_| EnvelopeError::BufferUnderflow)?;
    let mut total = n;
    let mut headers = Vec::new();
    for _ in 0..count {
        let (name, n) = decode_string_field(buf, offset + total, "header name")?;
        total += n;

        let (value, n) = decode_string_field(buf, offset + total, "header value")?;
        total += n;

        headers.push((name, value));
    }
    Ok((headers, total))
}

/// The request the connector is to make of the app behind a terminated
/// route: a method, a target, headers and a body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeRequest {
    pub method: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl EnvelopeRequest {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(TYPE_ENVELOPE_REQUEST);
        out.extend(encode_var_octet_string(self.method.as_bytes()));
        out.extend(encode_var_octet_string(self.target.as_bytes()));
        out.extend(encode_headers(&self.headers));
        out.extend(encode_var_octet_string(&self.body));
        out
    }

    pub fn decode(buf: &[u8]) -> Result<EnvelopeRequest, EnvelopeError> {
        let mut offset = decode_type_byte(buf, TYPE_ENVELOPE_REQUEST)?;

        let (method, n) = decode_string_field(buf, offset, "method")?;
        offset += n;

        let (target, n) = decode_string_field(buf, offset, "target")?;
        offset += n;

        let (headers, n) = decode_headers(buf, offset)?;
        offset += n;

        let (body, n) =
            decode_var_octet_string(buf, offset).map_err(|_| EnvelopeError::BufferUnderflow)?;
        offset += n;

        if offset != buf.len() {
            return Err(EnvelopeError::TrailingBytes);
        }

        Ok(EnvelopeRequest {
            method,
            target,
            headers,
            body,
        })
    }
}

/// The app's response back to the connector: a status, headers and a body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl EnvelopeResponse {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(TYPE_ENVELOPE_RESPONSE);
        out.extend_from_slice(&self.status.to_be_bytes());
        out.extend(encode_headers(&self.headers));
        out.extend(encode_var_octet_string(&self.body));
        out
    }

    pub fn decode(buf: &[u8]) -> Result<EnvelopeResponse, EnvelopeError> {
        let mut offset = decode_type_byte(buf, TYPE_ENVELOPE_RESPONSE)?;

        let status_end = offset + 2;
        if status_end > buf.len() {
            return Err(EnvelopeError::BufferUnderflow);
        }
        let status = u16::from_be_bytes([buf[offset], buf[offset + 1]]);
        offset = status_end;

        let (headers, n) = decode_headers(buf, offset)?;
        offset += n;

        let (body, n) =
            decode_var_octet_string(buf, offset).map_err(|_| EnvelopeError::BufferUnderflow)?;
        offset += n;

        if offset != buf.len() {
            return Err(EnvelopeError::TrailingBytes);
        }

        Ok(EnvelopeResponse {
            status,
            headers,
            body,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn sample_request() -> EnvelopeRequest {
        EnvelopeRequest {
            method: "POST".to_string(),
            target: "/orders".to_string(),
            headers: vec![
                ("content-type".to_string(), "application/json".to_string()),
                ("x-request-id".to_string(), "abc-123".to_string()),
            ],
            body: b"{\"item\":\"widget\"}".to_vec(),
        }
    }

    fn sample_response() -> EnvelopeResponse {
        EnvelopeResponse {
            status: 200,
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: b"{\"ok\":true}".to_vec(),
        }
    }

    #[test]
    fn request_round_trips() {
        let request = sample_request();
        let encoded = request.encode();
        assert_eq!(encoded[0], TYPE_ENVELOPE_REQUEST);
        assert_eq!(EnvelopeRequest::decode(&encoded).expect("decode"), request);
    }

    #[test]
    fn response_round_trips() {
        let response = sample_response();
        let encoded = response.encode();
        assert_eq!(encoded[0], TYPE_ENVELOPE_RESPONSE);
        assert_eq!(
            EnvelopeResponse::decode(&encoded).expect("decode"),
            response
        );
    }

    #[test]
    fn duplicate_header_names_survive_a_round_trip() {
        let mut request = sample_request();
        request.headers = vec![
            ("x-a".to_string(), "1".to_string()),
            ("x-a".to_string(), "2".to_string()),
        ];
        let encoded = request.encode();
        assert_eq!(EnvelopeRequest::decode(&encoded).expect("decode"), request);
    }

    #[test]
    fn header_order_survives_a_round_trip() {
        let mut request = sample_request();
        request.headers = vec![
            ("z-last".to_string(), "1".to_string()),
            ("a-first".to_string(), "2".to_string()),
        ];
        let encoded = request.encode();
        let decoded = EnvelopeRequest::decode(&encoded).expect("decode");
        assert_eq!(decoded.headers, request.headers);
    }

    #[test]
    fn request_decode_rejects_wrong_type_byte() {
        let mut encoded = sample_request().encode();
        encoded[0] = TYPE_ENVELOPE_RESPONSE;
        assert!(matches!(
            EnvelopeRequest::decode(&encoded),
            Err(EnvelopeError::InvalidType)
        ));
    }

    #[test]
    fn response_decode_rejects_wrong_type_byte() {
        let mut encoded = sample_response().encode();
        encoded[0] = TYPE_ENVELOPE_REQUEST;
        assert!(matches!(
            EnvelopeResponse::decode(&encoded),
            Err(EnvelopeError::InvalidType)
        ));
    }

    #[test]
    fn request_decode_rejects_truncated_input() {
        let encoded = sample_request().encode();
        assert!(matches!(
            EnvelopeRequest::decode(&encoded[..encoded.len() - 1]),
            Err(EnvelopeError::TrailingBytes) | Err(EnvelopeError::BufferUnderflow)
        ));
    }

    #[test]
    fn request_decode_rejects_trailing_bytes() {
        let mut encoded = sample_request().encode();
        encoded.push(0xff);
        assert!(matches!(
            EnvelopeRequest::decode(&encoded),
            Err(EnvelopeError::TrailingBytes)
        ));
    }

    #[test]
    fn response_decode_rejects_truncated_input() {
        let encoded = sample_response().encode();
        assert!(matches!(
            EnvelopeResponse::decode(&encoded[..encoded.len() - 1]),
            Err(EnvelopeError::TrailingBytes) | Err(EnvelopeError::BufferUnderflow)
        ));
    }

    #[test]
    fn response_decode_rejects_trailing_bytes() {
        let mut encoded = sample_response().encode();
        encoded.push(0xff);
        assert!(matches!(
            EnvelopeResponse::decode(&encoded),
            Err(EnvelopeError::TrailingBytes)
        ));
    }

    #[test]
    fn request_decode_rejects_invalid_utf8_in_method() {
        // Type byte, then a var-octet-string of length 1 containing an
        // invalid UTF-8 continuation byte with no leading byte.
        let encoded = vec![TYPE_ENVELOPE_REQUEST, 0x01, 0x80];
        assert!(matches!(
            EnvelopeRequest::decode(&encoded),
            Err(EnvelopeError::InvalidUtf8("method"))
        ));
    }

    #[test]
    fn empty_body_and_no_headers_round_trip() {
        let request = EnvelopeRequest {
            method: "GET".to_string(),
            target: "/".to_string(),
            headers: vec![],
            body: vec![],
        };
        let encoded = request.encode();
        assert_eq!(EnvelopeRequest::decode(&encoded).expect("decode"), request);
    }

    fn arbitrary_headers() -> impl Strategy<Value = Vec<(String, String)>> {
        proptest::collection::vec((".*", ".*"), 0..8)
    }

    fn arbitrary_request() -> impl Strategy<Value = EnvelopeRequest> {
        (
            ".*",
            ".*",
            arbitrary_headers(),
            proptest::collection::vec(any::<u8>(), 0..64),
        )
            .prop_map(|(method, target, headers, body)| EnvelopeRequest {
                method,
                target,
                headers,
                body,
            })
    }

    fn arbitrary_response() -> impl Strategy<Value = EnvelopeResponse> {
        (
            any::<u16>(),
            arbitrary_headers(),
            proptest::collection::vec(any::<u8>(), 0..64),
        )
            .prop_map(|(status, headers, body)| EnvelopeResponse {
                status,
                headers,
                body,
            })
    }

    proptest! {
        /// Issue #519's first acceptance criterion: encoding then decoding
        /// any valid request envelope returns exactly what went in.
        #[test]
        fn any_request_round_trips(request in arbitrary_request()) {
            let encoded = request.encode();
            let decoded = EnvelopeRequest::decode(&encoded).expect("decode");
            prop_assert_eq!(decoded, request);
        }

        /// Same property, response direction -- "one shape, two directions".
        #[test]
        fn any_response_round_trips(response in arbitrary_response()) {
            let encoded = response.encode();
            let decoded = EnvelopeResponse::decode(&encoded).expect("decode");
            prop_assert_eq!(decoded, response);
        }

        /// Header order and duplicate header names are both meaningful in
        /// an HTTP request and must both survive, for either direction.
        #[test]
        fn header_list_round_trips_exactly(headers in arbitrary_headers()) {
            let request = EnvelopeRequest {
                method: "GET".to_string(),
                target: "/".to_string(),
                headers,
                body: vec![],
            };
            let encoded = request.encode();
            let decoded = EnvelopeRequest::decode(&encoded).expect("decode");
            prop_assert_eq!(decoded.headers, request.headers);
        }

        /// Decoding must never panic on arbitrary bytes, whichever
        /// direction is attempted -- a reject is fine, a crash is not.
        #[test]
        fn decode_never_panics_on_arbitrary_bytes(
            bytes in proptest::collection::vec(any::<u8>(), 0..256)
        ) {
            let _ = EnvelopeRequest::decode(&bytes);
            let _ = EnvelopeResponse::decode(&bytes);
        }
    }
}
