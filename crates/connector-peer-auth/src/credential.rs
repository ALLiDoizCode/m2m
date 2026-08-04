//! The credential an interaction presents: one struct, one JSON shape, two
//! encodings (`peer-carriage-spec.md` §1.4).
//!
//! ```json
//! { "peerId": "store-box", "secret": "…" }
//! ```
//!
//! | Carriage | Presentation |
//! | -------- | ------------ |
//! | BTP | the `auth` protocolData entry, raw UTF-8 JSON, on the session's first MESSAGE |
//! | ILP-over-HTTP | the `Toon-Peer-Auth` request header, `base64(JSON)`, on **every** request |
//!
//! The two encodings share this module's parser and its serializer, so a
//! credential one carriage accepts is one the other accepts, byte for byte
//! after the base64 layer (spec I7). Base64 is a header artifact and
//! nothing else — the same relationship `client-edge-spec.md` §1.9 already
//! establishes for a claim.
//!
//! # What is *not* here
//!
//! Which entry or header a payload came out of. The carriages select their
//! own bytes — a BTP carriage filters `protocolData` by
//! [`PEER_AUTH_PROTOCOL_ENTRY`], an HTTP carriage reads
//! [`PEER_AUTH_HEADER`] — and hand this module payloads. That keeps the
//! decision path free of frame and request types (§1.3) while still
//! declaring both names in one place, as one pair, so a header cannot be
//! added without its protocolData twin (spec I2).

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fmt;

/// The BTP protocolData entry a credential rides in: the `auth` entry
/// `client-edge-spec.md` §1.9 step 1 already reads. Unchanged in shape and
/// unchanged in what a client sends — what ADR 0027 changes is that a
/// connector now *evaluates* P1 and P2 against it instead of accepting its
/// contents unverified.
pub const PEER_AUTH_PROTOCOL_ENTRY: &str = "auth";

/// The HTTP request header a credential rides in, in its canonical
/// lower-case form (§1.4). Named here rather than derived from the
/// protocolData entry: the two spellings are a declared pair, not a
/// transformation.
pub const PEER_AUTH_HEADER: &str = "toon-peer-auth";

/// The two names for one concept, declared once as a pair (spec I2).
///
/// The pairing is the point. A carriage that reads a header whose
/// protocolData twin was never declared is exactly the fork issue #713 was
/// opened to prevent, and a pair is the shape that makes declaring half of
/// one impossible to express.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CarriageNames {
    /// The BTP `protocolData` entry name.
    pub btp_protocol_entry: &'static str,
    /// The HTTP request header name, canonical lower-case.
    pub http_header: &'static str,
}

/// The credential's name on each carriage.
pub const PEER_AUTH_NAMES: CarriageNames = CarriageNames {
    btp_protocol_entry: PEER_AUTH_PROTOCOL_ENTRY,
    http_header: PEER_AUTH_HEADER,
};

/// A credential as an interaction presented it — an *assertion*, until
/// [`crate::decide_role`] weighs it against configuration.
///
/// It carries a peer id and a secret and nothing else. That is not
/// minimalism: it is §1.3 made structural. A value of this type cannot
/// carry the carriage it arrived on, the port it hit, its source address
/// or its TLS name, so the decision that consumes it cannot weight one.
///
/// The secret never appears in a [`fmt::Debug`] rendering, for the same
/// reason [`connector_config::PeerCredential`]'s does not: a presented
/// credential is the kind of value that gets logged whole while someone is
/// debugging a peering that will not establish, and the wrong secret in a
/// log aggregator is still a secret in a log aggregator.
#[derive(Clone)]
pub struct PresentedCredential {
    peer_id: String,
    secret: String,
}

impl PresentedCredential {
    /// The credential an interaction presented, or the one this connector
    /// will present when it dials a peer:
    /// `PresentedCredential::new(peer.id(), peer.credential().secret())`.
    #[must_use]
    pub fn new(peer_id: impl Into<String>, secret: impl Into<String>) -> Self {
        PresentedCredential {
            peer_id: peer_id.into(),
            secret: secret.into(),
        }
    }

    /// The peer id this credential *asserts*. Asserting is all it does:
    /// nothing downstream may treat this string as identifying a peer
    /// until [`crate::decide_role`] has proven it (§1.6).
    #[must_use]
    pub fn asserted_peer_id(&self) -> &str {
        &self.peer_id
    }

    /// Whether `configured` is the secret this credential presents.
    ///
    /// Deliberately the only reader of the secret: there is no
    /// `secret()` accessor, so the sole thing a caller can do with a
    /// presented secret is compare it — in constant time, through
    /// [`connector_config::PeerCredential::matches`], with the
    /// empty-configured-secret rule that comparison owns.
    #[must_use]
    pub fn proves(&self, configured: &connector_config::PeerCredential) -> bool {
        configured.matches(&self.secret)
    }
}

impl fmt::Debug for PresentedCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PresentedCredential")
            .field("peerId", &self.peer_id)
            .field("secret", &"<redacted>")
            .finish()
    }
}

/// The JSON shape, kept private so the public type cannot be serialized by
/// accident somewhere that logs its input.
#[derive(Serialize, Deserialize)]
struct CredentialJson {
    // Not `deny_unknown_fields`: the BTP `auth` entry is shared with the
    // client edge, where §1.9 step 1's contents are richer and
    // unverified. A strict parse would turn a peer whose credential
    // carries one extra field into a silent client with no
    // `peer_auth_refused` to show for it -- the exact failure §1.6 exists
    // to prevent.
    #[serde(rename = "peerId")]
    peer_id: String,
    secret: String,
}

/// Why a payload was not a credential.
///
/// Callers on both carriages fold this into "no credential presented"
/// ([`present_raw`], [`present_base64`]): §1.7 and §12.5 make client-role
/// fields *ignored*, not refused, so an undecodable credential admits a
/// client rather than erroring — and no error message discloses the peer
/// surface. The variants exist so the dial side and this crate's tests can
/// say which encoding layer failed.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CredentialDecodeError {
    /// The header value was not standard base64.
    #[error("credential is not valid base64")]
    NotBase64,
    /// The decoded bytes were not the credential JSON of §1.4.
    #[error("credential is not the JSON object of peer-carriage-spec.md §1.4")]
    NotCredentialJson,
}

/// More than one credential was presented on one frame or one request.
///
/// Refused, never resolved (§1.5). The connector MUST NOT pick the first,
/// the last, or a concatenation: this is the header-smuggling defence, and
/// its absence is how "which credential did we check?" becomes
/// unanswerable. The carriage maps it — BTP: an ERROR frame (`code F00`,
/// `name NotAcceptedError`); HTTP: `400` with no ILP body.
///
/// It is role-independent on purpose. An ambiguous credential is refused
/// whether or not any of its candidates would have proven a peer, because
/// deciding *which* to evaluate is the thing that cannot be done safely.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error(
    "more than one peer credential presented on one interaction: ambiguous credentials are \
     refused, not resolved (peer-carriage-spec.md §1.5)"
)]
pub struct AmbiguousCredential {
    /// How many were presented. Two or more, by construction.
    pub presented: usize,
}

/// Serialize a credential to the raw UTF-8 JSON a BTP `auth` entry carries.
#[must_use]
pub fn encode_raw(credential: &PresentedCredential) -> Vec<u8> {
    let json = CredentialJson {
        peer_id: credential.peer_id.clone(),
        secret: credential.secret.clone(),
    };
    // The shape is two owned `String`s; there is no value of
    // `CredentialJson` that fails to serialize.
    serde_json::to_vec(&json).expect("credential JSON is always serializable")
}

/// Serialize a credential to the `base64(JSON)` a `Toon-Peer-Auth` header
/// carries -- the *same* JSON [`encode_raw`] produces, wrapped.
#[must_use]
pub fn encode_base64(credential: &PresentedCredential) -> String {
    STANDARD.encode(encode_raw(credential))
}

/// Parse the raw UTF-8 JSON of a BTP `auth` entry.
pub fn decode_raw(payload: &[u8]) -> Result<PresentedCredential, CredentialDecodeError> {
    let json: CredentialJson =
        serde_json::from_slice(payload).map_err(|_| CredentialDecodeError::NotCredentialJson)?;
    Ok(PresentedCredential::new(json.peer_id, json.secret))
}

/// Parse the `base64(JSON)` of a `Toon-Peer-Auth` header value.
///
/// Standard base64 with padding, and only that. A forgiving decoder would
/// make one carriage accept a spelling the other's vectors do not pin,
/// which is the drift spec I1 exists to prevent.
pub fn decode_base64(value: &[u8]) -> Result<PresentedCredential, CredentialDecodeError> {
    let decoded = STANDARD
        .decode(value)
        .map_err(|_| CredentialDecodeError::NotBase64)?;
    decode_raw(&decoded)
}

/// The credential a BTP frame presents, from every `auth` entry on it.
///
/// The caller passes the payload of each `protocolData` entry named
/// [`PEER_AUTH_PROTOCOL_ENTRY`], in frame order. Zero entries is `None` —
/// an interaction that presents no credential is a client, which is the
/// overwhelmingly common case and not an error. Two or more is
/// [`AmbiguousCredential`], **counted before anything is parsed**, so a
/// second undecodable entry cannot be quietly discarded to leave one
/// unambiguous credential standing.
pub fn present_raw<'a, I>(entries: I) -> Result<Option<PresentedCredential>, AmbiguousCredential>
where
    I: IntoIterator<Item = &'a [u8]>,
{
    present_with(entries, decode_raw)
}

/// The credential an HTTP request presents, from every `Toon-Peer-Auth`
/// header value on it. As [`present_raw`], over the base64 encoding.
pub fn present_base64<'a, I>(values: I) -> Result<Option<PresentedCredential>, AmbiguousCredential>
where
    I: IntoIterator<Item = &'a [u8]>,
{
    present_with(values, decode_base64)
}

fn present_with<'a, I, D>(
    payloads: I,
    decode: D,
) -> Result<Option<PresentedCredential>, AmbiguousCredential>
where
    I: IntoIterator<Item = &'a [u8]>,
    D: Fn(&[u8]) -> Result<PresentedCredential, CredentialDecodeError>,
{
    let payloads: Vec<&[u8]> = payloads.into_iter().collect();
    if payloads.len() > 1 {
        return Err(AmbiguousCredential {
            presented: payloads.len(),
        });
    }
    // An undecodable credential is a client, not an error (§12.5): a
    // client SDK setting an unrecognised header must not be broken by a
    // peer feature, and no error message may disclose the peer surface.
    Ok(payloads.first().and_then(|payload| decode(payload).ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures() -> Vec<(String, String)> {
        vec![
            ("store-box".to_string(), "shared-secret".to_string()),
            ("relay-box".to_string(), String::new()),
            (String::new(), "shared-secret".to_string()),
            (
                "péer-ünicode".to_string(),
                "sécret with spaces and \"quotes\"".to_string(),
            ),
            ("store-box".to_string(), "a".repeat(4096)),
        ]
    }

    #[test]
    fn the_json_shape_is_peer_id_and_secret() {
        let encoded = encode_raw(&PresentedCredential::new("store-box", "s3cret"));

        assert_eq!(
            String::from_utf8(encoded).expect("utf-8"),
            r#"{"peerId":"store-box","secret":"s3cret"}"#
        );
    }

    /// Spec I7: one credential in one JSON shape, so a carriage cannot
    /// accept a credential the other would refuse. Asserted over the
    /// decoded *value*, not the bytes, exactly as I1 requires of every
    /// paired encoding.
    #[test]
    fn both_encodings_decode_to_the_same_credential() {
        for (peer_id, secret) in fixtures() {
            let fixture = PresentedCredential::new(peer_id.clone(), secret.clone());
            let raw = decode_raw(&encode_raw(&fixture)).expect("raw round trip");
            let based =
                decode_base64(encode_base64(&fixture).as_bytes()).expect("base64 round trip");
            let configured = connector_config::PeerCredential::new(secret.clone());

            assert_eq!(raw.asserted_peer_id(), peer_id);
            assert_eq!(based.asserted_peer_id(), peer_id);
            // The secret survived both encodings identically. An empty
            // fixture secret proves nothing on either side, which is the
            // empty-secret rule showing through rather than a difference
            // between the encodings.
            assert_eq!(raw.proves(&configured), !secret.is_empty());
            assert_eq!(based.proves(&configured), raw.proves(&configured));
        }
    }

    #[test]
    fn the_base64_encoding_wraps_exactly_the_raw_one() {
        let fixture = PresentedCredential::new("store-box", "s3cret");

        let unwrapped = STANDARD
            .decode(encode_base64(&fixture))
            .expect("standard base64");

        assert_eq!(unwrapped, encode_raw(&fixture));
    }

    #[test]
    fn a_credential_never_debug_prints_its_secret() {
        let rendered = format!("{:?}", PresentedCredential::new("store-box", "s3cret"));

        assert!(!rendered.contains("s3cret"), "got: {rendered}");
        assert!(rendered.contains("redacted"), "got: {rendered}");
        assert!(rendered.contains("store-box"), "got: {rendered}");
    }

    #[test]
    fn extra_fields_do_not_make_a_peer_invisible() {
        let payload = br#"{"peerId":"store-box","secret":"s3cret","protocol":"btp"}"#;

        let credential = decode_raw(payload).expect("decodes");

        assert_eq!(credential.asserted_peer_id(), "store-box");
    }

    #[test]
    fn a_non_json_payload_is_not_a_credential() {
        assert_eq!(
            decode_raw(b"not json at all").unwrap_err(),
            CredentialDecodeError::NotCredentialJson
        );
        assert_eq!(
            decode_raw(br#"{"peerId":"store-box"}"#).unwrap_err(),
            CredentialDecodeError::NotCredentialJson
        );
        assert_eq!(
            decode_base64(b"!!! not base64 !!!").unwrap_err(),
            CredentialDecodeError::NotBase64
        );
    }

    #[test]
    fn no_entries_presents_no_credential() {
        let none: Vec<&[u8]> = Vec::new();

        assert!(present_raw(none.clone()).expect("no refusal").is_none());
        assert!(present_base64(none).expect("no refusal").is_none());
    }

    #[test]
    fn an_undecodable_entry_presents_no_credential_rather_than_an_error() {
        let garbage: Vec<&[u8]> = vec![b"not json"];

        assert!(present_raw(garbage).expect("not refused").is_none());
    }

    /// §1.5's header-smuggling defence: refused, not resolved.
    #[test]
    fn two_credentials_are_refused_not_resolved() {
        let first = encode_raw(&PresentedCredential::new("store-box", "s3cret"));
        let second = encode_raw(&PresentedCredential::new("relay-box", "other"));
        let entries: Vec<&[u8]> = vec![&first, &second];

        assert_eq!(
            present_raw(entries).unwrap_err(),
            AmbiguousCredential { presented: 2 }
        );
    }

    /// The variant that resolving would get wrong: one valid credential
    /// and one garbage entry. Discarding the garbage would leave exactly
    /// one credential standing and answer "which one did we check?" with
    /// "whichever parsed", so the count is taken before anything parses.
    #[test]
    fn a_valid_credential_beside_a_garbage_one_is_still_refused() {
        let valid = encode_base64(&PresentedCredential::new("store-box", "s3cret"));
        let entries: Vec<&[u8]> = vec![valid.as_bytes(), b"!!!"];

        assert_eq!(
            present_base64(entries).unwrap_err(),
            AmbiguousCredential { presented: 2 }
        );
    }

    #[test]
    fn two_byte_identical_credentials_are_still_refused() {
        let encoded = encode_raw(&PresentedCredential::new("store-box", "s3cret"));
        let entries: Vec<&[u8]> = vec![&encoded, &encoded];

        assert!(present_raw(entries).is_err());
    }

    /// Spec I2: the header and the protocolData entry are one declared
    /// pair, and the entry half must stay the frame grammar's own
    /// spelling. A peer carriage that read a different `auth` entry name
    /// than the client edge does would be reading nothing.
    #[test]
    fn the_protocol_entry_name_does_not_fork_from_the_frame_grammar() {
        assert_eq!(
            PEER_AUTH_NAMES.btp_protocol_entry,
            connector_btp::AUTH_PROTOCOL
        );
        assert_eq!(PEER_AUTH_NAMES.http_header, "toon-peer-auth");
        assert_eq!(
            PEER_AUTH_NAMES.http_header,
            PEER_AUTH_NAMES.http_header.to_ascii_lowercase(),
            "the header name is declared in its canonical lower-case form (§1.4)"
        );
    }
}
