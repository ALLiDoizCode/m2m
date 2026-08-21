//! NIP-01 event signing, for the one event this connector ever authors: its
//! own kind:10032 `IlpPeerInfo` announce (issue #784).
//!
//! It lives in this crate because this crate is the connector's sole owner
//! of key handling (ADR 0012) -- an announce is signed with the node's own
//! `[signer]` identity key, the same secp256k1 secret that opens gift wraps
//! and answers `GET /ilp/identity`, and that key must never be read
//! anywhere else.
//!
//! # Why this is not `Signer::sign`
//!
//! A Nostr signature is **BIP-340 Schnorr over the event's own SHA-256 id**,
//! under an x-only public key. [`crate::Signer`] produces a *recoverable
//! ECDSA* signature over a digest -- a different algorithm with a different
//! encoding, verified by different code. `libsecp256k1` 0.6 (this crate's
//! ECDSA implementation) does not do Schnorr at all, hence `k256`'s
//! `schnorr` module here; `devnet_store_leg_probe.rs` already reaches for
//! the same crate for the same reason, which is precisely why this belongs
//! behind one function instead of being hand-rolled a second time.
//!
//! # The id is a serialization, and the serialization is the spec
//!
//! NIP-01: `id = sha256(utf8(json([0, <pubkey>, <created_at>, <kind>, <tags>,
//! <content>])))` -- the six-element array, no whitespace, and only the
//! escapes NIP-01 names (`\n`, `\"`, `\\`, `\r`, `\t`, `\b`, `\f`).
//! `serde_json` produces exactly that set for a string and nothing else, so
//! the serialization here is `serde_json`'s rather than a hand-written
//! escaper -- an escaper is how two implementations of one hash end up
//! disagreeing about one event in a thousand.
//!
//! # kind:10032 is REGULAR replaceable, so there is no `d` tag
//!
//! 10032 sits in NIP-01's regular replaceable range (10000-19999): a relay
//! replaces a node's previous announce by `(pubkey, kind)` alone. A `d` tag
//! belongs only to the PARAMETERIZED replaceable range (30000-39999), and
//! the retired TypeScript builder emitted none for exactly this reason.
//! Neither does this.

use k256::schnorr::signature::hazmat::PrehashSigner;
use k256::schnorr::SigningKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::SignerError;

/// kind:10032 -- the ILP peer info announcement, in NIP-01's regular
/// replaceable range.
pub const ILP_PEER_INFO_KIND: u64 = 10_032;

/// NIP-40's tag name. An announce carrying one expires on its own when the
/// node behind it stops announcing, instead of lingering on every relay
/// that ever saw it.
pub const EXPIRATION_TAG: &str = "expiration";

/// A signed NIP-01 event, in the field order and spelling every relay and
/// every `@toon-protocol/core` parser already reads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NostrEvent {
    /// Lowercase hex of the 32-byte id -- the SHA-256 of the NIP-01
    /// serialization below.
    pub id: String,
    /// Lowercase hex of the 32-byte x-only public key.
    pub pubkey: String,
    pub created_at: u64,
    pub kind: u64,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    /// Lowercase hex of the 64-byte BIP-340 signature over `id`.
    pub sig: String,
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Build and sign a NIP-01 event with `secret_key`.
///
/// `secret_key` is the node's own 32-byte identity secret. It is taken by
/// value rather than through a [`crate::Signer`] because BIP-340 needs the
/// scalar itself (see the module docs); a KMS-held key cannot sign an
/// announce, and a caller holding one should say so rather than reaching
/// around this function.
pub fn sign_event(
    secret_key: &[u8; 32],
    kind: u64,
    content: String,
    tags: Vec<Vec<String>>,
    created_at: u64,
) -> Result<NostrEvent, SignerError> {
    let signing_key = SigningKey::from_bytes(secret_key).map_err(|_| SignerError::InvalidKey)?;
    let pubkey = hex_encode(&signing_key.verifying_key().to_bytes());

    // NIP-01's serialization for the id: the six-element array, no
    // whitespace. `to_string` on a `serde_json::Value` emits exactly that.
    let serialized = serde_json::json!([0, pubkey, created_at, kind, tags, content]).to_string();
    let id_bytes: [u8; 32] = Sha256::digest(serialized.as_bytes()).into();

    let signature: k256::schnorr::Signature = signing_key
        .sign_prehash(&id_bytes)
        .map_err(|error| SignerError::SigningFailed(error.to_string()))?;

    Ok(NostrEvent {
        id: hex_encode(&id_bytes),
        pubkey,
        created_at,
        kind,
        tags,
        content,
        sig: hex_encode(&signature.to_bytes()),
    })
}

/// Build and sign this node's kind:10032 announce: `content` is the
/// serialized `IlpPeerInfo`, and `ttl_secs` becomes a NIP-40
/// `["expiration", created_at + ttl_secs]` tag.
///
/// The TTL is not optional here, unlike the sidecar's (whose `ttlSeconds`
/// could be omitted for a non-expiring event). A node announces itself; if
/// it stops, the announce should stop too, and "forever" is not a thing an
/// operator should be able to configure by leaving a field out.
pub fn sign_ilp_peer_info(
    secret_key: &[u8; 32],
    content: String,
    created_at: u64,
    ttl_secs: u64,
) -> Result<NostrEvent, SignerError> {
    let tags = vec![vec![
        EXPIRATION_TAG.to_string(),
        (created_at + ttl_secs).to_string(),
    ]];
    sign_event(secret_key, ILP_PEER_INFO_KIND, content, tags, created_at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::schnorr::signature::hazmat::PrehashVerifier;
    use k256::schnorr::VerifyingKey;

    const SECRET: [u8; 32] = [7u8; 32];

    /// Verified the way a relay verifies it: recover the x-only key from
    /// the event's own `pubkey` field and check the BIP-340 signature
    /// against the id the event carries. A relay with `verifyEvent` on
    /// (every TOON relay, dev mode off) refuses anything this rejects.
    fn verify(event: &NostrEvent) {
        let pubkey_bytes = (0..32)
            .map(|i| u8::from_str_radix(&event.pubkey[i * 2..i * 2 + 2], 16).expect("hex"))
            .collect::<Vec<u8>>();
        let verifying = VerifyingKey::from_bytes(&pubkey_bytes).expect("x-only public key");
        let id_bytes = (0..32)
            .map(|i| u8::from_str_radix(&event.id[i * 2..i * 2 + 2], 16).expect("hex"))
            .collect::<Vec<u8>>();
        let sig_bytes = (0..64)
            .map(|i| u8::from_str_radix(&event.sig[i * 2..i * 2 + 2], 16).expect("hex"))
            .collect::<Vec<u8>>();
        let signature =
            k256::schnorr::Signature::try_from(sig_bytes.as_slice()).expect("64-byte signature");
        verifying
            .verify_prehash(&id_bytes, &signature)
            .expect("a relay must accept this signature");
    }

    #[test]
    fn a_signed_announce_verifies_the_way_a_relay_verifies_it() {
        let event = sign_ilp_peer_info(
            &SECRET,
            r#"{"ilpAddress":"g.toon.ario"}"#.into(),
            1_700,
            600,
        )
        .expect("sign");

        assert_eq!(event.kind, ILP_PEER_INFO_KIND);
        assert_eq!(event.created_at, 1_700);
        verify(&event);
    }

    /// The id is a hash of the serialization, so any change to any field
    /// changes it -- asserted against a recomputation rather than a
    /// hardcoded digest, so the test is about the rule and not about one
    /// fixture.
    #[test]
    fn the_id_is_the_sha256_of_nip01s_six_element_serialization() {
        let event = sign_ilp_peer_info(&SECRET, "{}".into(), 1_700, 600).expect("sign");
        let expected = serde_json::json!([
            0,
            event.pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content
        ])
        .to_string();
        assert_eq!(event.id, hex_encode(&Sha256::digest(expected.as_bytes())));
    }

    /// NIP-40: the tag is `created_at + ttl`, and it is the ONLY tag. A `d`
    /// tag here would be the parameterized-replaceable spelling of a
    /// regular-replaceable kind -- see the module docs.
    #[test]
    fn the_only_tag_is_nip40s_expiration_at_created_at_plus_ttl() {
        let event = sign_ilp_peer_info(&SECRET, "{}".into(), 1_000, 600).expect("sign");

        assert_eq!(
            event.tags,
            vec![vec!["expiration".to_string(), "1600".into()]]
        );
    }

    /// An all-zero secret is not a scalar on the curve, and a node whose
    /// key file somehow held one must be told rather than panic.
    #[test]
    fn an_unusable_secret_is_an_error_rather_than_a_panic() {
        assert_eq!(
            sign_ilp_peer_info(&[0u8; 32], "{}".into(), 1, 1).unwrap_err(),
            SignerError::InvalidKey
        );
    }
}
