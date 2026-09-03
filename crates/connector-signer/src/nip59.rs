//! NIP-59-inspired transport-privacy wrapping for a client-edge payment
//! claim (`docs/protocol/client-edge-spec.md` §1.3's
//! `ILP-Payment-Channel-Claim-Wrapped` header; issue #504). Ported from the deleted
//! `packages/connector/src/settlement/privacy/nip59-claim-wrapper.ts` (git
//! history at `c4a4ad10^`), the only prior definition of this wire format --
//! field names, layer order and the shared-secret derivation below are
//! recovered from it, not guessed at.
//!
//! Layers, innermost first:
//! - **Rumor**: the plaintext claim JSON (unsigned, deniable).
//! - **Seal**: the rumor, ChaCha20-Poly1305-encrypted to the receiver and
//!   signed (this crate's own ECDSA, [`crate::crypto::sign_digest`]) by the
//!   sender over the ciphertext.
//! - **Gift wrap**: the seal, ChaCha20-Poly1305-encrypted with a one-time
//!   ephemeral key, so the receiver learns nothing about the sender's
//!   identity from this layer alone.
//!
//! Both layers key their cipher from the same ECDH construction the deleted
//! reference used: the raw X-coordinate of `secret * public` (via
//! [`libsecp256k1::PublicKey::tweak_mul_assign`], not the crate's own
//! digest-mixing `SharedSecret`, so this stays a bit-exact port), run
//! through HKDF-SHA256 with a layer-specific info string, with a random
//! 12-byte nonce prepended to each layer's ciphertext.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use libsecp256k1::{PublicKey, SecretKey};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::crypto::{ecdh_x_coordinate as shared_ecdh_x_coordinate, sign_digest, verify_digest};
use crate::signer::{PublicKeyBytes, Signature};

const NONCE_LEN: usize = 12;
const SEAL_INFO: &[u8] = b"nip59-seal";
const GIFTWRAP_INFO: &[u8] = b"nip59-giftwrap";

/// Why wrapping or unwrapping failed. Never carries decrypted claim content
/// (the deleted reference's own `NIP59WrapError` made the same choice).
#[derive(Debug, Error, PartialEq, Eq)]
pub enum Nip59Error {
    #[error("invalid ephemeral, sender or receiver public key")]
    InvalidKey,
    #[error("gift wrap layer failed to decrypt")]
    GiftWrapDecryptFailed,
    #[error("seal layer is not the expected JSON shape")]
    MalformedSeal,
    #[error("seal signature does not verify against its own embedded sender key")]
    SealSignatureInvalid,
    #[error("seal layer failed to decrypt")]
    SealDecryptFailed,
}

/// The three-layer wrapped envelope, once the
/// `ILP-Payment-Channel-Claim-Wrapped` header's base64 and outer JSON
/// (`{ephemeralPublicKey, encryptedPayload, timestamp, version}`) have
/// already been peeled off by the caller -- this module only ever sees the
/// two fields it actually uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrappedClaim {
    pub ephemeral_public_key: PublicKeyBytes,
    /// A random 12-byte nonce followed by the ChaCha20-Poly1305 ciphertext
    /// of the (JSON-encoded) seal layer.
    pub encrypted_payload: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
struct SealPayload {
    #[serde(rename = "senderPublicKey")]
    sender_public_key: String,
    signature: String,
    #[serde(rename = "sealCiphertext")]
    seal_ciphertext: String,
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// The deleted reference's `_computeSharedSecret`
/// (`getSharedSecret(..., true).slice(1)`) -- [`shared_ecdh_x_coordinate`]
/// mapped onto this module's own error type, so the byte sequence handed to
/// HKDF matches the ported algorithm exactly.
fn ecdh_x_coordinate(secret: &SecretKey, public: &PublicKey) -> Result<[u8; 32], Nip59Error> {
    shared_ecdh_x_coordinate(secret, public).ok_or(Nip59Error::InvalidKey)
}

fn hkdf_key(shared_secret: &[u8; 32], info: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, shared_secret);
    let mut okm = [0u8; 32];
    hk.expand(info, &mut okm)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    okm
}

fn sha256_digest(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Vec<u8> {
    let cipher = ChaCha20Poly1305::new(&Key::from(*key));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(&Nonce::from(nonce_bytes), plaintext)
        .expect("chacha20poly1305 encryption of a bounded claim payload cannot fail");
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    out
}

fn decrypt(key: &[u8; 32], nonce_and_ciphertext: &[u8]) -> Option<Vec<u8>> {
    if nonce_and_ciphertext.len() < NONCE_LEN {
        return None;
    }
    let (nonce_bytes, ciphertext) = nonce_and_ciphertext.split_at(NONCE_LEN);
    let nonce: [u8; NONCE_LEN] = nonce_bytes.try_into().expect("checked length above");
    let cipher = ChaCha20Poly1305::new(&Key::from(*key));
    cipher.decrypt(&Nonce::from(nonce), ciphertext).ok()
}

/// Wrap `rumor` (the plaintext claim JSON) for `receiver_public`, signed as
/// having come from `sender_secret`. Exposed for round-trip testing and for
/// anything in this workspace that ever needs to produce a wrapped claim
/// (today, nothing does -- production wrapping is a client-side concern,
/// `docs/protocol/client-edge-spec.md` §1.3).
pub fn wrap_claim(
    rumor: &[u8],
    sender_secret: &SecretKey,
    receiver_public: &PublicKeyBytes,
) -> Result<WrappedClaim, Nip59Error> {
    let receiver_public = PublicKey::parse(receiver_public).map_err(|_| Nip59Error::InvalidKey)?;
    let sender_public = PublicKey::from_secret_key(sender_secret);

    let seal_shared = ecdh_x_coordinate(sender_secret, &receiver_public)?;
    let seal_key = hkdf_key(&seal_shared, SEAL_INFO);
    let seal_ciphertext = encrypt(&seal_key, rumor);
    let seal_signature = sign_digest(sender_secret, &sha256_digest(&seal_ciphertext));

    let seal_payload = SealPayload {
        sender_public_key: hex_encode(&sender_public.serialize()),
        signature: hex_encode(&seal_signature.to_bytes()),
        seal_ciphertext: BASE64.encode(&seal_ciphertext),
    };
    let seal_payload_bytes =
        serde_json::to_vec(&seal_payload).expect("SealPayload always serializes to JSON");

    let mut ephemeral_secret_bytes = [0u8; 32];
    let ephemeral_secret = loop {
        OsRng.fill_bytes(&mut ephemeral_secret_bytes);
        if let Ok(key) = SecretKey::parse(&ephemeral_secret_bytes) {
            break key;
        }
    };
    let ephemeral_public = PublicKey::from_secret_key(&ephemeral_secret);
    let giftwrap_shared = ecdh_x_coordinate(&ephemeral_secret, &receiver_public)?;
    let giftwrap_key = hkdf_key(&giftwrap_shared, GIFTWRAP_INFO);
    let encrypted_payload = encrypt(&giftwrap_key, &seal_payload_bytes);

    Ok(WrappedClaim {
        ephemeral_public_key: ephemeral_public.serialize(),
        encrypted_payload,
    })
}

/// Unwrap `wrapped`, recovering the plaintext rumor bytes (the claim JSON)
/// that `wrap_claim` sealed -- client-edge-spec.md §1.3's "a wrapped one is
/// unwrapped and parsed". Fails distinctly at whichever layer breaks, so a
/// caller can tell a corrupt gift wrap from a forged seal signature; either
/// way, the caller's job (this ticket's own scope) is simply to treat any
/// [`Nip59Error`] as a structurally invalid claim.
///
/// Takes the receiver's secret key as raw bytes rather than
/// `libsecp256k1::SecretKey` -- unlike `wrap_claim` (test-only today, see
/// its own doc), this is the function `connector-client-edge` actually
/// calls in production, and per this crate's own charter ("no other crate
/// in this workspace holds key material or performs a signing operation
/// directly") no other crate should need a `libsecp256k1` dependency just
/// to call it.
pub fn unwrap_claim(
    wrapped: &WrappedClaim,
    receiver_secret: &[u8; 32],
) -> Result<Vec<u8>, Nip59Error> {
    let receiver_secret = SecretKey::parse(receiver_secret).map_err(|_| Nip59Error::InvalidKey)?;
    let receiver_secret = &receiver_secret;
    let ephemeral_public =
        PublicKey::parse(&wrapped.ephemeral_public_key).map_err(|_| Nip59Error::InvalidKey)?;
    let giftwrap_shared = ecdh_x_coordinate(receiver_secret, &ephemeral_public)?;
    let giftwrap_key = hkdf_key(&giftwrap_shared, GIFTWRAP_INFO);
    let seal_payload_bytes = decrypt(&giftwrap_key, &wrapped.encrypted_payload)
        .ok_or(Nip59Error::GiftWrapDecryptFailed)?;

    let seal_payload: SealPayload =
        serde_json::from_slice(&seal_payload_bytes).map_err(|_| Nip59Error::MalformedSeal)?;
    let sender_public_bytes =
        hex_decode(&seal_payload.sender_public_key).ok_or(Nip59Error::MalformedSeal)?;
    let sender_public_array: PublicKeyBytes = sender_public_bytes
        .as_slice()
        .try_into()
        .map_err(|_| Nip59Error::MalformedSeal)?;
    let sender_public =
        PublicKey::parse(&sender_public_array).map_err(|_| Nip59Error::MalformedSeal)?;
    let signature_bytes = hex_decode(&seal_payload.signature).ok_or(Nip59Error::MalformedSeal)?;
    let signature = Signature::from_bytes(&signature_bytes).ok_or(Nip59Error::MalformedSeal)?;
    let seal_ciphertext = BASE64
        .decode(&seal_payload.seal_ciphertext)
        .map_err(|_| Nip59Error::MalformedSeal)?;

    let seal_digest = sha256_digest(&seal_ciphertext);
    if !verify_digest(&sender_public_array, &seal_digest, &signature) {
        return Err(Nip59Error::SealSignatureInvalid);
    }

    let seal_shared = ecdh_x_coordinate(receiver_secret, &sender_public)?;
    let seal_key = hkdf_key(&seal_shared, SEAL_INFO);
    decrypt(&seal_key, &seal_ciphertext).ok_or(Nip59Error::SealDecryptFailed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::generate_keypair;

    fn keypair() -> (SecretKey, PublicKey) {
        generate_keypair()
    }

    #[test]
    fn a_wrapped_claim_unwraps_to_the_original_rumor() {
        let (sender_secret, _sender_public) = keypair();
        let (receiver_secret, receiver_public) = keypair();
        let rumor = br#"{"version":"1.0","blockchain":"evm"}"#;

        let wrapped =
            wrap_claim(rumor, &sender_secret, &receiver_public.serialize()).expect("wrap");
        let unwrapped = unwrap_claim(&wrapped, &receiver_secret.serialize()).expect("unwrap");

        assert_eq!(unwrapped, rumor);
    }

    #[test]
    fn the_wrong_receiver_key_cannot_unwrap() {
        let (sender_secret, _sender_public) = keypair();
        let (_receiver_secret, receiver_public) = keypair();
        let (wrong_secret, _wrong_public) = keypair();
        let rumor = b"top secret claim";

        let wrapped =
            wrap_claim(rumor, &sender_secret, &receiver_public.serialize()).expect("wrap");
        let result = unwrap_claim(&wrapped, &wrong_secret.serialize());

        assert_eq!(result, Err(Nip59Error::GiftWrapDecryptFailed));
    }

    #[test]
    fn a_tampered_gift_wrap_ciphertext_fails_to_decrypt() {
        let (sender_secret, _sender_public) = keypair();
        let (receiver_secret, receiver_public) = keypair();
        let rumor = b"a claim";

        let mut wrapped =
            wrap_claim(rumor, &sender_secret, &receiver_public.serialize()).expect("wrap");
        let last = wrapped.encrypted_payload.len() - 1;
        wrapped.encrypted_payload[last] ^= 0xFF;

        assert_eq!(
            unwrap_claim(&wrapped, &receiver_secret.serialize()),
            Err(Nip59Error::GiftWrapDecryptFailed)
        );
    }

    #[test]
    fn a_forged_seal_signature_is_rejected() {
        // Build a wrapped claim whose seal layer was signed by an impostor
        // key different from the one the seal payload's own JSON declares
        // -- simulated here by re-encrypting a seal payload whose signature
        // was computed over different ciphertext bytes than the ones
        // actually shipped, exactly what a corrupted-in-transit seal would
        // look like.
        let (sender_secret, sender_public) = keypair();
        let (receiver_secret, receiver_public) = keypair();
        let (impostor_secret, _impostor_public) = keypair();

        let seal_shared = ecdh_x_coordinate(&sender_secret, &receiver_public).unwrap();
        let seal_key = hkdf_key(&seal_shared, SEAL_INFO);
        let seal_ciphertext = encrypt(&seal_key, b"a claim");
        // Sign with the impostor's key instead of the sender's.
        let forged_signature = sign_digest(&impostor_secret, &sha256_digest(&seal_ciphertext));
        let seal_payload = SealPayload {
            sender_public_key: hex_encode(&sender_public.serialize()),
            signature: hex_encode(&forged_signature.to_bytes()),
            seal_ciphertext: BASE64.encode(&seal_ciphertext),
        };
        let seal_payload_bytes = serde_json::to_vec(&seal_payload).unwrap();

        let mut ephemeral_secret_bytes = [0u8; 32];
        let ephemeral_secret = loop {
            OsRng.fill_bytes(&mut ephemeral_secret_bytes);
            if let Ok(key) = SecretKey::parse(&ephemeral_secret_bytes) {
                break key;
            }
        };
        let ephemeral_public = PublicKey::from_secret_key(&ephemeral_secret);
        let giftwrap_shared = ecdh_x_coordinate(&ephemeral_secret, &receiver_public).unwrap();
        let giftwrap_key = hkdf_key(&giftwrap_shared, GIFTWRAP_INFO);
        let encrypted_payload = encrypt(&giftwrap_key, &seal_payload_bytes);

        let wrapped = WrappedClaim {
            ephemeral_public_key: ephemeral_public.serialize(),
            encrypted_payload,
        };

        assert_eq!(
            unwrap_claim(&wrapped, &receiver_secret.serialize()),
            Err(Nip59Error::SealSignatureInvalid)
        );
    }

    #[test]
    fn hex_round_trips() {
        let bytes = [0xab, 0xcd, 0x00, 0xff];
        assert_eq!(hex_decode(&hex_encode(&bytes)).unwrap(), bytes);
    }
}
