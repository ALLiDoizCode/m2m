use libsecp256k1::{Message, PublicKey, RecoveryId, SecretKey, Signature as RawSignature};
use rand::rngs::OsRng;

use crate::signer::{PublicKeyBytes, Signature};

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

/// Whether `signature` over `digest` recovers to exactly `public_key` --
/// the check a claim's payee runs before accepting it (peer-wire-spec.md
/// §3.4's `signature_invalid` rejection reason). Malformed signature bytes
/// (out of curve range, an invalid recovery id) are a verification
/// failure, not an error a caller needs to distinguish from any other
/// forged claim.
pub(crate) fn verify_digest(
    public_key: &PublicKeyBytes,
    digest: &[u8; 32],
    signature: &Signature,
) -> bool {
    let Ok(expected) = PublicKey::parse(public_key) else {
        return false;
    };

    let mut serialized = [0u8; 64];
    serialized[..32].copy_from_slice(&signature.r);
    serialized[32..].copy_from_slice(&signature.s);
    let Ok(raw_signature) = RawSignature::parse_standard(&serialized) else {
        return false;
    };
    let Ok(recovery_id) = RecoveryId::parse(signature.recovery_id) else {
        return false;
    };
    let message = Message::parse(digest);

    match libsecp256k1::recover(&message, &raw_signature, &recovery_id) {
        Ok(recovered) if recovered == expected => {
            libsecp256k1::verify(&message, &raw_signature, &expected)
        }
        _ => false,
    }
}
