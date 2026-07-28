//! Generates the committed cross-repo wire-vector set (issue #527, ADR 0021)
//! from fixed literal fixtures run through the real implementations these
//! vectors are evidence for -- never from bytes captured once and pinned
//! after the fact. See `docs/protocol/wire-vectors.md` for the invariants
//! each section below is evidence of.
//!
//! Every vector [`generate`] emits is checked, before being returned,
//! against the same function that would validate it for real (`decode`,
//! `open_request`/`open_response`, or `fulfillment_matches_condition`) --
//! this module cannot silently commit a vector its own implementation would
//! reject or fail to reproduce.
//!
//! Fixtures (`IDENTITY_SECRET`, `EPHEMERAL_SECRET`, ...) are literal,
//! non-secret bytes chosen only so this crate compiles to the same output
//! every time it runs -- never a real operator's key.

use connector_domain::{
    derive_condition, fulfillment_matches_condition, EnvelopeError, EnvelopeRequest,
    EnvelopeResponse,
};
use connector_signer::giftwrap::{
    derive_fulfillment, open_request, open_response, seal_request_with_randomness,
    seal_response_with_randomness,
};
use connector_signer::{LocalSigner, Signer};
use serde::Serialize;

/// The vector-set schema version. Bump when a field's meaning changes in a
/// way an existing SDK's replay code would misread -- a purely additive
/// field does not require a bump.
pub const SCHEMA_VERSION: u32 = 1;

fn seq_bytes<const N: usize>(start: u8) -> [u8; N] {
    let mut out = [0u8; N];
    for (i, b) in out.iter_mut().enumerate() {
        *b = start.wrapping_add(i as u8);
    }
    out
}

fn hex_of(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

#[derive(Debug, Serialize)]
pub struct WireVectors {
    pub schema_version: u32,
    pub envelope: EnvelopeVectors,
    pub giftwrap: GiftwrapVectors,
    pub fulfilment: FulfilmentVectors,
}

#[derive(Debug, Serialize)]
pub struct EnvelopeVectors {
    pub valid: Vec<EnvelopeValidVector>,
    pub invalid: Vec<EnvelopeInvalidVector>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "direction", rename_all = "snake_case")]
pub enum EnvelopeFields {
    Request {
        method: String,
        target: String,
        headers: Vec<(String, String)>,
        body_hex: String,
    },
    Response {
        status: u16,
        headers: Vec<(String, String)>,
        body_hex: String,
    },
}

#[derive(Debug, Serialize)]
pub struct EnvelopeValidVector {
    pub name: &'static str,
    pub encoded_hex: String,
    pub decoded: EnvelopeFields,
}

#[derive(Debug, Serialize)]
pub struct EnvelopeInvalidVector {
    pub name: &'static str,
    pub direction: &'static str,
    pub bytes_hex: String,
    pub expected_error: &'static str,
}

#[derive(Debug, Serialize)]
pub struct GiftwrapVectors {
    pub receiver_identity_secret_hex: String,
    pub receiver_identity_public_hex: String,
    pub cases: Vec<GiftwrapCase>,
}

#[derive(Debug, Serialize)]
pub struct GiftwrapCase {
    pub name: &'static str,
    pub ephemeral_secret_hex: String,
    pub shared_secret_hex: String,
    pub request_nonce_hex: String,
    pub response_nonce_hex: String,
    pub request_envelope: EnvelopeFields,
    pub request_envelope_hex: String,
    pub request_wrap_hex: String,
    pub response_envelope: EnvelopeFields,
    pub response_envelope_hex: String,
    pub response_wrap_hex: String,
}

#[derive(Debug, Serialize)]
pub struct FulfilmentVectors {
    pub cases: Vec<FulfilmentCase>,
}

#[derive(Debug, Serialize)]
pub struct FulfilmentCase {
    pub name: &'static str,
    pub shared_secret_hex: String,
    pub fulfilment_hex: String,
    pub condition_hex: String,
    pub matches: bool,
}

/// This module's own name for each [`EnvelopeError`] variant -- stable
/// across a `Debug` reformat, and independent of Rust's `Debug` output
/// shape, since a replaying SDK matches on this string, not on
/// `format!("{err:?}")`.
fn error_tag(err: &EnvelopeError) -> &'static str {
    match err {
        EnvelopeError::BufferUnderflow => "buffer_underflow",
        EnvelopeError::NonCanonicalLength => "non_canonical_length",
        EnvelopeError::LengthDeterminantOverflow => "length_determinant_overflow",
        EnvelopeError::InvalidType => "invalid_type",
        EnvelopeError::InvalidUtf8(_) => "invalid_utf8",
        EnvelopeError::TrailingBytes => "trailing_bytes",
    }
}

fn generate_envelope_vectors() -> EnvelopeVectors {
    let minimal_request = EnvelopeRequest {
        method: "GET".to_string(),
        target: "/".to_string(),
        headers: vec![],
        body: vec![],
    };
    let posted_order = EnvelopeRequest {
        method: "POST".to_string(),
        target: "/orders".to_string(),
        headers: vec![
            ("content-type".to_string(), "application/json".to_string()),
            ("x-request-id".to_string(), "vector-0001".to_string()),
        ],
        body: b"{\"item\":\"widget\"}".to_vec(),
    };
    let duplicate_headers = EnvelopeRequest {
        method: "GET".to_string(),
        target: "/search?q=%E2%9C%93".to_string(),
        headers: vec![
            ("x-a".to_string(), "1".to_string()),
            ("x-a".to_string(), "2".to_string()),
        ],
        body: vec![],
    };
    let ok_response = EnvelopeResponse {
        status: 200,
        headers: vec![("content-type".to_string(), "application/json".to_string())],
        body: b"{\"ok\":true}".to_vec(),
    };
    let binary_body_response = EnvelopeResponse {
        status: 206,
        headers: vec![
            (
                "content-type".to_string(),
                "application/octet-stream".to_string(),
            ),
            ("x-a".to_string(), "1".to_string()),
            ("x-a".to_string(), "2".to_string()),
        ],
        body: vec![0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f],
    };

    let mut valid = Vec::new();
    for (name, request) in [
        ("minimal_get_request", minimal_request),
        ("post_with_headers_and_json_body", posted_order),
        ("get_with_duplicate_header_names", duplicate_headers),
    ] {
        let encoded = request.encode();
        let decoded = EnvelopeRequest::decode(&encoded)
            .unwrap_or_else(|e| panic!("vector {name} does not decode: {e:?}"));
        assert_eq!(decoded, request, "vector {name} did not round-trip");
        valid.push(EnvelopeValidVector {
            name,
            encoded_hex: hex_of(&encoded),
            decoded: EnvelopeFields::Request {
                method: request.method,
                target: request.target,
                headers: request.headers.clone(),
                body_hex: hex_of(&request.body),
            },
        });
    }
    for (name, response) in [
        ("ok_json_response", ok_response),
        (
            "partial_content_binary_body_and_duplicate_headers",
            binary_body_response,
        ),
    ] {
        let encoded = response.encode();
        let decoded = EnvelopeResponse::decode(&encoded)
            .unwrap_or_else(|e| panic!("vector {name} does not decode: {e:?}"));
        assert_eq!(decoded, response, "vector {name} did not round-trip");
        valid.push(EnvelopeValidVector {
            name,
            encoded_hex: hex_of(&encoded),
            decoded: EnvelopeFields::Response {
                status: response.status,
                headers: response.headers.clone(),
                body_hex: hex_of(&response.body),
            },
        });
    }

    let mut invalid = Vec::new();

    let canonical_get_root: Vec<u8> = vec![1, 0x03, b'G', b'E', b'T', 0x01, b'/', 0x00, 0x00];

    let mut wrong_type_as_request = canonical_get_root.clone();
    wrong_type_as_request[0] = 2;
    invalid.push(check_invalid(
        "request_decode_rejects_wrong_type_byte",
        "request",
        wrong_type_as_request,
        EnvelopeError::InvalidType,
        |b| EnvelopeRequest::decode(b).err(),
    ));

    let ok_response_encoded = EnvelopeResponse {
        status: 200,
        headers: vec![],
        body: vec![],
    }
    .encode();
    let mut wrong_type_as_response = ok_response_encoded.clone();
    wrong_type_as_response[0] = 1;
    invalid.push(check_invalid(
        "response_decode_rejects_wrong_type_byte",
        "response",
        wrong_type_as_response,
        EnvelopeError::InvalidType,
        |b| EnvelopeResponse::decode(b).err(),
    ));

    let truncated = canonical_get_root[..canonical_get_root.len() - 1].to_vec();
    let truncated_err = EnvelopeRequest::decode(&truncated)
        .expect_err("a truncated canonical request must not decode");
    invalid.push(EnvelopeInvalidVector {
        name: "request_decode_rejects_truncated_input",
        direction: "request",
        bytes_hex: hex_of(&truncated),
        expected_error: error_tag(&truncated_err),
    });

    let mut trailing = canonical_get_root.clone();
    trailing.push(0xff);
    invalid.push(check_invalid(
        "request_decode_rejects_trailing_bytes",
        "request",
        trailing,
        EnvelopeError::TrailingBytes,
        |b| EnvelopeRequest::decode(b).err(),
    ));

    let invalid_utf8 = vec![1u8, 0x01, 0x80];
    let invalid_utf8_err = EnvelopeRequest::decode(&invalid_utf8)
        .expect_err("an invalid UTF-8 method must not decode");
    invalid.push(EnvelopeInvalidVector {
        name: "request_decode_rejects_invalid_utf8_in_method",
        direction: "request",
        bytes_hex: hex_of(&invalid_utf8),
        expected_error: error_tag(&invalid_utf8_err),
    });

    let mut non_minimal_length = canonical_get_root.clone();
    non_minimal_length.splice(1..2, [0x81, 0x03]);
    invalid.push(check_invalid(
        "request_decode_rejects_a_non_minimal_length_determinant",
        "request",
        non_minimal_length,
        EnvelopeError::NonCanonicalLength,
        |b| EnvelopeRequest::decode(b).err(),
    ));

    let zero_length_alias = vec![1u8, 0x80, 0x01, b'/', 0x00, 0x00];
    invalid.push(check_invalid(
        "request_decode_rejects_a_zero_length_long_form_alias",
        "request",
        zero_length_alias,
        EnvelopeError::NonCanonicalLength,
        |b| EnvelopeRequest::decode(b).err(),
    ));

    let mut over_long_determinant = vec![1u8, 0x89];
    over_long_determinant.extend([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);
    over_long_determinant.extend([b'G', b'E', b'T', 0x01, b'/', 0x00, 0x00]);
    invalid.push(check_invalid(
        "request_decode_rejects_an_over_long_determinant_instead_of_truncating",
        "request",
        over_long_determinant,
        EnvelopeError::LengthDeterminantOverflow,
        |b| EnvelopeRequest::decode(b).err(),
    ));

    EnvelopeVectors { valid, invalid }
}

fn check_invalid(
    name: &'static str,
    direction: &'static str,
    bytes: Vec<u8>,
    expected: EnvelopeError,
    decode: impl Fn(&[u8]) -> Option<EnvelopeError>,
) -> EnvelopeInvalidVector {
    let actual = decode(&bytes).unwrap_or_else(|| panic!("vector {name} unexpectedly decoded"));
    assert_eq!(actual, expected, "vector {name} produced the wrong error");
    EnvelopeInvalidVector {
        name,
        direction,
        bytes_hex: hex_of(&bytes),
        expected_error: error_tag(&actual),
    }
}

fn generate_giftwrap_vectors() -> (GiftwrapVectors, [u8; 32]) {
    const IDENTITY_SECRET: [u8; 32] = seq_bytes_const::<32>(0x01);
    let ephemeral_secret = seq_bytes::<32>(0x21);
    let shared_secret = seq_bytes::<32>(0x41);
    let request_nonce = seq_bytes::<12>(0x61);
    let response_nonce = seq_bytes::<12>(0x6d);

    let receiver = LocalSigner::from_secret_bytes("vector-fixture-identity", IDENTITY_SECRET)
        .expect("fixture identity secret is a valid secp256k1 scalar");
    let receiver_public = receiver
        .public_key()
        .expect("fixture identity has a public key");

    let request_envelope = EnvelopeRequest {
        method: "POST".to_string(),
        target: "/orders".to_string(),
        headers: vec![("content-type".to_string(), "application/json".to_string())],
        body: b"{\"item\":\"widget\"}".to_vec(),
    };
    let request_plaintext = request_envelope.encode();

    let request_wrap = seal_request_with_randomness(
        &request_plaintext,
        &receiver_public,
        &ephemeral_secret,
        &shared_secret,
        &request_nonce,
    )
    .expect("fixture request seals cleanly");
    let (opened_plaintext, opened_secret) = open_request(&request_wrap, &receiver)
        .expect("the receiver's own signer opens a wrap sealed to its identity");
    assert_eq!(opened_plaintext, request_plaintext);
    assert_eq!(opened_secret, shared_secret);

    let response_envelope = EnvelopeResponse {
        status: 200,
        headers: vec![("content-type".to_string(), "application/json".to_string())],
        body: b"{\"ok\":true}".to_vec(),
    };
    let response_plaintext = response_envelope.encode();

    let response_wrap =
        seal_response_with_randomness(&shared_secret, &response_plaintext, &response_nonce);
    let opened_response = open_response(&shared_secret, &response_wrap)
        .expect("the request's own shared secret opens the response sealed with it");
    assert_eq!(opened_response, response_plaintext);

    let case = GiftwrapCase {
        name: "sealed_request_and_response_round_trip",
        ephemeral_secret_hex: hex_of(&ephemeral_secret),
        shared_secret_hex: hex_of(&shared_secret),
        request_nonce_hex: hex_of(&request_nonce),
        response_nonce_hex: hex_of(&response_nonce),
        request_envelope: EnvelopeFields::Request {
            method: request_envelope.method,
            target: request_envelope.target,
            headers: request_envelope.headers.clone(),
            body_hex: hex_of(&request_envelope.body),
        },
        request_envelope_hex: hex_of(&request_plaintext),
        request_wrap_hex: hex_of(&request_wrap),
        response_envelope: EnvelopeFields::Response {
            status: response_envelope.status,
            headers: response_envelope.headers.clone(),
            body_hex: hex_of(&response_envelope.body),
        },
        response_envelope_hex: hex_of(&response_plaintext),
        response_wrap_hex: hex_of(&response_wrap),
    };

    (
        GiftwrapVectors {
            receiver_identity_secret_hex: hex_of(&IDENTITY_SECRET),
            receiver_identity_public_hex: hex_of(&receiver_public),
            cases: vec![case],
        },
        shared_secret,
    )
}

fn generate_fulfilment_vectors(giftwrap_shared_secret: [u8; 32]) -> FulfilmentVectors {
    let fulfilment = derive_fulfillment(&giftwrap_shared_secret);
    let condition = derive_condition(&fulfilment);
    assert!(
        fulfillment_matches_condition(&condition, &fulfilment),
        "a fulfilment must satisfy the condition derived from it"
    );

    let other_secret = seq_bytes::<32>(0x81);
    let other_fulfilment = derive_fulfillment(&other_secret);
    assert!(
        !fulfillment_matches_condition(&condition, &other_fulfilment),
        "a different secret's fulfilment must not satisfy this condition"
    );

    FulfilmentVectors {
        cases: vec![
            FulfilmentCase {
                name: "derived_fulfilment_satisfies_its_own_condition",
                shared_secret_hex: hex_of(&giftwrap_shared_secret),
                fulfilment_hex: hex_of(&fulfilment),
                condition_hex: hex_of(&condition),
                matches: true,
            },
            FulfilmentCase {
                name: "a_different_secrets_fulfilment_does_not_satisfy_this_condition",
                shared_secret_hex: hex_of(&other_secret),
                fulfilment_hex: hex_of(&other_fulfilment),
                condition_hex: hex_of(&condition),
                matches: false,
            },
        ],
    }
}

/// A `const fn` twin of [`seq_bytes`], needed only because
/// [`LocalSigner::from_secret_bytes`]'s fixture must be a `const` (an
/// associated `const` in scope for the whole function, not a value computed
/// after other fixtures) -- both produce the identical byte sequence for the
/// same `start`.
const fn seq_bytes_const<const N: usize>(start: u8) -> [u8; N] {
    let mut out = [0u8; N];
    let mut i = 0;
    while i < N {
        out[i] = start.wrapping_add(i as u8);
        i += 1;
    }
    out
}

/// Build the full committed vector set. See the module docs for what
/// "generated from the properties" means here, and
/// `docs/protocol/wire-vectors.md` for the invariant each section pins.
pub fn generate() -> WireVectors {
    let envelope = generate_envelope_vectors();
    let (giftwrap, shared_secret) = generate_giftwrap_vectors();
    let fulfilment = generate_fulfilment_vectors(shared_secret);

    WireVectors {
        schema_version: SCHEMA_VERSION,
        envelope,
        giftwrap,
        fulfilment,
    }
}

/// Pretty-printed JSON, newline-terminated -- the exact bytes both the
/// generator binary writes to disk and the gate test compares against.
pub fn to_json(vectors: &WireVectors) -> String {
    let mut json = serde_json::to_string_pretty(vectors).expect("WireVectors always serializes");
    json.push('\n');
    json
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_does_not_panic() {
        let _ = generate();
    }

    #[test]
    fn generating_twice_produces_byte_identical_output() {
        assert_eq!(to_json(&generate()), to_json(&generate()));
    }
}
