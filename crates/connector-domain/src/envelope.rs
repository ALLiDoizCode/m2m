//! The envelope: the literal HTTP request/response carried in a PREPARE's
//! (respectively FULFILL's) `data` field at a locally-terminated route. See
//! `docs/protocol/client-edge-spec.md` §1.7, which this module implements --
//! every quirk here is stated and justified there; this file states none of
//! the reasoning twice.
//!
//! Recovered from a hand-rolled parser (issue #216) whose TypeScript source
//! was deleted from this repository (#465); this is a from-scratch
//! implementation against the written specification, not a port of that
//! source.

use thiserror::Error;

use crate::packet::RejectCode;

const CRLF: &str = "\r\n";
const HEADER_DELIMITER: &[u8] = b"\r\n\r\n";

/// A decoded HTTP request envelope (client-edge-spec.md §1.7.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequestEnvelope {
    pub method: String,
    /// request-target (path + query), e.g. `/greet?x=1`.
    pub target: String,
    /// HTTP version token, e.g. `HTTP/1.1`.
    pub http_version: String,
    /// Header fields in wire order, casing preserved, duplicates kept
    /// (§1.7.2).
    pub headers: Vec<(String, String)>,
    /// Raw body bytes (may be empty).
    pub body: Vec<u8>,
}

/// A response envelope to encode (client-edge-spec.md §1.7.1). This
/// connector only ever produces one -- see the module doc -- so there is no
/// corresponding decode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponseEnvelope {
    pub http_version: String,
    pub status: u16,
    pub reason_phrase: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// Everything that can go wrong decoding a request envelope
/// (client-edge-spec.md §1.7.3). A malformed request-line and a header line
/// without a colon are deliberately distinct variants -- both are
/// `F01_INVALID_PACKET` at the protocol level (see [`reject_code`]), but an
/// operator debugging a client's envelope needs to know which half of the
/// head was wrong.
///
/// [`reject_code`]: EnvelopeError::reject_code
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum EnvelopeError {
    #[error("empty envelope")]
    Empty,
    #[error("missing request-line")]
    MissingRequestLine,
    #[error("malformed request-line: \"{0}\"")]
    MalformedRequestLine(String),
    #[error("malformed header line: \"{0}\"")]
    MalformedHeaderLine(String),
}

impl EnvelopeError {
    /// The reject code this decode failure fixes to, per
    /// `docs/protocol/client-edge-spec.md` §1.7.3.
    pub fn reject_code(&self) -> RejectCode {
        match self {
            EnvelopeError::Empty => RejectCode::f06_unexpected_payment(),
            EnvelopeError::MissingRequestLine
            | EnvelopeError::MalformedRequestLine(_)
            | EnvelopeError::MalformedHeaderLine(_) => RejectCode::f01_invalid_packet(),
        }
    }
}

/// Decode Latin-1 (ISO-8859-1): every byte maps to the code point of the
/// same value, one-to-one (§1.7.2).
fn latin1_decode(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

/// Encode Latin-1, the inverse of [`latin1_decode`]. Only ever called on
/// text this module itself produced or decoded, so every char is already
/// `<= 0x00FF` and the truncation below is exact, not lossy.
fn latin1_encode(text: &str) -> Vec<u8> {
    text.chars().map(|c| c as u32 as u8).collect()
}

fn find_header_delimiter(data: &[u8]) -> Option<usize> {
    data.windows(HEADER_DELIMITER.len())
        .position(|window| window == HEADER_DELIMITER)
}

/// Decode a request envelope from a PREPARE's `data` field
/// (client-edge-spec.md §1.7).
pub fn decode_request(data: &[u8]) -> Result<HttpRequestEnvelope, EnvelopeError> {
    if data.is_empty() {
        return Err(EnvelopeError::Empty);
    }

    // §1.7.2: no blank line means the whole payload is head, empty body.
    let (head, body) = match find_header_delimiter(data) {
        Some(index) => (
            &data[..index],
            data[index + HEADER_DELIMITER.len()..].to_vec(),
        ),
        None => (data, Vec::new()),
    };

    let head_text = latin1_decode(head);
    let mut lines = head_text.split(CRLF);
    let request_line = lines
        .next()
        .filter(|line| !line.is_empty())
        .ok_or(EnvelopeError::MissingRequestLine)?;

    // request-line = method SP request-target SP HTTP-version
    let first_space = request_line.find(' ');
    let last_space = request_line.rfind(' ');
    let (method, target, http_version) = match (first_space, last_space) {
        (Some(first), Some(last)) if first != last => (
            &request_line[..first],
            &request_line[first + 1..last],
            &request_line[last + 1..],
        ),
        _ => {
            return Err(EnvelopeError::MalformedRequestLine(
                request_line.to_string(),
            ))
        }
    };
    if method.is_empty() || target.is_empty() || !http_version.starts_with("HTTP/") {
        return Err(EnvelopeError::MalformedRequestLine(
            request_line.to_string(),
        ));
    }

    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            // Tolerate a stray blank line before the terminating one.
            continue;
        }
        let colon = line
            .find(':')
            .ok_or_else(|| EnvelopeError::MalformedHeaderLine(line.to_string()))?;
        let name = &line[..colon];
        // §1.7.2: only leading OWS after the colon is stripped.
        let value = line[colon + 1..].trim_start_matches([' ', '\t']);
        headers.push((name.to_string(), value.to_string()));
    }

    Ok(HttpRequestEnvelope {
        method: method.to_string(),
        target: target.to_string(),
        http_version: http_version.to_string(),
        headers,
        body,
    })
}

/// Encode an envelope's start-line, headers, and body into the wire format
/// shared by requests and responses (§1.7.1): `start_line CRLF *(header CRLF)
/// CRLF body`. Shared by [`encode_request`] and [`encode_response`], which
/// differ only in how they build `start_line`.
fn encode_envelope(start_line: &str, headers: &[(String, String)], body: &[u8]) -> Vec<u8> {
    let mut head_lines = vec![start_line.to_string()];
    for (name, value) in headers {
        head_lines.push(format!("{name}: {value}"));
    }
    let head_text = head_lines.join(CRLF) + CRLF + CRLF;
    let mut out = latin1_encode(&head_text);
    out.extend_from_slice(body);
    out
}

/// Encode a request envelope, the inverse of [`decode_request`].
pub fn encode_request(envelope: &HttpRequestEnvelope) -> Vec<u8> {
    let request_line = format!(
        "{} {} {}",
        envelope.method, envelope.target, envelope.http_version
    );
    encode_envelope(&request_line, &envelope.headers, &envelope.body)
}

/// Encode a response envelope for a FULFILL's `data` field
/// (client-edge-spec.md §1.7). There is no `decode_response`: this
/// connector only ever produces one, per the module doc.
pub fn encode_response(envelope: &HttpResponseEnvelope) -> Vec<u8> {
    let status_line = format!(
        "{} {} {}",
        envelope.http_version, envelope.status, envelope.reason_phrase
    )
    .trim_end()
    .to_string();
    encode_envelope(&status_line, &envelope.headers, &envelope.body)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a literal HTTP request envelope buffer, mirroring how a real
    /// client constructs one on the wire.
    fn build_request(method: &str, target: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut head_lines = vec![format!("{method} {target} HTTP/1.1")];
        for (name, value) in headers {
            head_lines.push(format!("{name}: {value}"));
        }
        let mut out = latin1_encode(&(head_lines.join(CRLF) + CRLF + CRLF));
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn decodes_a_request_line_headers_and_body() {
        let buf = build_request(
            "POST",
            "/greet?x=1",
            &[
                ("Host", "example.test"),
                ("Content-Type", "application/json"),
            ],
            b"{\"hello\":\"world\"}",
        );
        let envelope = decode_request(&buf).expect("decode");
        assert_eq!(envelope.method, "POST");
        assert_eq!(envelope.target, "/greet?x=1");
        assert_eq!(envelope.http_version, "HTTP/1.1");
        assert_eq!(
            envelope.headers,
            vec![
                ("Host".to_string(), "example.test".to_string()),
                ("Content-Type".to_string(), "application/json".to_string()),
            ]
        );
        assert_eq!(envelope.body, b"{\"hello\":\"world\"}");
    }

    #[test]
    fn is_byte_faithful_decode_then_encode_round_trips_the_original_buffer() {
        let buf = build_request(
            "PUT",
            "/items/42",
            &[("X-Custom-Header", "KeepCase"), ("Accept", "text/plain")],
            b"arbitrary body bytes",
        );
        let envelope = decode_request(&buf).expect("decode");
        assert_eq!(encode_request(&envelope), buf);
    }

    #[test]
    fn preserves_binary_body_bytes_exactly() {
        let bin_body = [0x00, 0xff, 0x10, 0x0d, 0x0a, 0x42];
        let buf = build_request(
            "POST",
            "/bin",
            &[("Content-Type", "application/octet-stream")],
            &bin_body,
        );
        let envelope = decode_request(&buf).expect("decode");
        assert_eq!(envelope.body, bin_body);
        assert_eq!(encode_request(&envelope), buf);
    }

    #[test]
    fn preserves_header_name_casing_not_normalized() {
        let buf = build_request("GET", "/", &[("X-MiXeD-CaSe", "v")], b"");
        let envelope = decode_request(&buf).expect("decode");
        assert_eq!(envelope.headers[0].0, "X-MiXeD-CaSe");
    }

    #[test]
    fn preserves_duplicate_headers_as_an_ordered_list_not_folded() {
        let buf = build_request("GET", "/", &[("X-Foo", "one"), ("X-Foo", "two")], b"");
        let envelope = decode_request(&buf).expect("decode");
        assert_eq!(
            envelope.headers,
            vec![
                ("X-Foo".to_string(), "one".to_string()),
                ("X-Foo".to_string(), "two".to_string()),
            ]
        );
    }

    #[test]
    fn strips_leading_ows_after_the_colon_but_keeps_internal_spaces() {
        let raw = format!("GET / HTTP/1.1{CRLF}X-H:  a b {CRLF}{CRLF}");
        let envelope = decode_request(&latin1_encode(&raw)).expect("decode");
        assert_eq!(envelope.headers[0], ("X-H".to_string(), "a b ".to_string()));
    }

    #[test]
    fn handles_a_header_only_request_with_no_body_delimiter() {
        let raw = format!("GET /ping HTTP/1.1{CRLF}Host: x");
        let envelope = decode_request(&latin1_encode(&raw)).expect("decode");
        assert_eq!(envelope.method, "GET");
        assert!(envelope.body.is_empty());
    }

    #[test]
    fn errors_on_empty_data() {
        assert_eq!(decode_request(&[]), Err(EnvelopeError::Empty));
    }

    #[test]
    fn errors_on_a_malformed_request_line() {
        let raw = format!("GARBAGE{CRLF}{CRLF}");
        assert!(matches!(
            decode_request(&latin1_encode(&raw)),
            Err(EnvelopeError::MalformedRequestLine(_))
        ));
    }

    #[test]
    fn errors_on_a_header_line_without_a_colon() {
        let raw = format!("GET / HTTP/1.1{CRLF}no-colon-here{CRLF}{CRLF}");
        assert!(matches!(
            decode_request(&latin1_encode(&raw)),
            Err(EnvelopeError::MalformedHeaderLine(_))
        ));
    }

    /// A malformed request-line and a header line without a colon must be
    /// distinguishable failures, not just both "some decode error".
    #[test]
    fn a_malformed_request_line_and_a_headerless_colon_are_distinguishable_failures() {
        let bad_request_line = decode_request(&latin1_encode(&format!("GARBAGE{CRLF}{CRLF}")));
        let bad_header_line = decode_request(&latin1_encode(&format!(
            "GET / HTTP/1.1{CRLF}no-colon-here{CRLF}{CRLF}"
        )));
        assert_ne!(bad_request_line, bad_header_line);
        assert!(matches!(
            bad_request_line,
            Err(EnvelopeError::MalformedRequestLine(_))
        ));
        assert!(matches!(
            bad_header_line,
            Err(EnvelopeError::MalformedHeaderLine(_))
        ));
    }

    #[test]
    fn reject_codes_fix_per_the_specification() {
        assert_eq!(EnvelopeError::Empty.reject_code().as_str(), "F06");
        assert_eq!(
            EnvelopeError::MissingRequestLine.reject_code().as_str(),
            "F01"
        );
        assert_eq!(
            EnvelopeError::MalformedRequestLine("x".to_string())
                .reject_code()
                .as_str(),
            "F01"
        );
        assert_eq!(
            EnvelopeError::MalformedHeaderLine("x".to_string())
                .reject_code()
                .as_str(),
            "F01"
        );
    }

    #[test]
    fn encode_response_produces_a_byte_faithful_status_line_headers_and_body() {
        let buf = encode_response(&HttpResponseEnvelope {
            http_version: "HTTP/1.1".to_string(),
            status: 201,
            reason_phrase: "Created".to_string(),
            headers: vec![("Content-Type".to_string(), "text/plain".to_string())],
            body: b"ok".to_vec(),
        });
        assert_eq!(
            buf,
            format!("HTTP/1.1 201 Created{CRLF}Content-Type: text/plain{CRLF}{CRLF}ok").as_bytes()
        );
    }
}
