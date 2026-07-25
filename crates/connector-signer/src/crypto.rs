use libsecp256k1::{Message, PublicKey, SecretKey};
use rand::rngs::OsRng;

use crate::signer::Signature;

/// Generate a fresh secp256k1 key pair, shared by every [`crate::Signer`]
/// implementation that mints its own keys (local generation and the
/// in-memory KMS fake alike).
pub(crate) fn generate_keypair() -> (SecretKey, PublicKey) {
    let mut rng = OsRng;
    let secret = SecretKey::random(&mut rng);
    let public = PublicKey::from_secret_key(&secret);
    (secret, public)
}

/// Sign `digest` with `secret`, packaging libsecp256k1's raw output into
/// this crate's [`Signature`] shape.
pub(crate) fn sign_digest(secret: &SecretKey, digest: &[u8; 32]) -> Signature {
    let message = Message::parse(digest);
    let (sig, recovery_id) = libsecp256k1::sign(&message, secret);
    let serialized = sig.serialize();
    let mut r = [0u8; 32];
    let mut s = [0u8; 32];
    r.copy_from_slice(&serialized[..32]);
    s.copy_from_slice(&serialized[32..]);
    Signature {
        r,
        s,
        recovery_id: recovery_id.into(),
    }
}
