use crate::crypto::verify_digest;
use crate::error::SignerError;

/// An uncompressed secp256k1 public key: a `0x04` prefix followed by the
/// 32-byte X and Y coordinates.
pub type PublicKeyBytes = [u8; 65];

/// A recoverable ECDSA signature over a 32-byte digest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Signature {
    pub r: [u8; 32],
    pub s: [u8; 32],
    pub recovery_id: u8,
}

/// The signer port (ADR 0012): the single interface anything that needs to
/// sign a claim or a settlement transaction depends on. There are exactly
/// two implementations in this crate — [`crate::LocalSigner`], which holds
/// key material directly, and [`crate::KmsSigner`], which reaches it through
/// a key management service boundary — and both satisfy the same contract
/// suite (see `contract.rs`).
///
/// Every method takes `&self` so a key can be rotated without taking the
/// signer offline: implementations guard mutable key state behind a lock
/// that readers never block on for longer than a swap.
pub trait Signer: Send + Sync {
    /// The identifier of the key currently in use.
    fn key_id(&self) -> String;

    /// The uncompressed public key of the currently active key.
    fn public_key(&self) -> Result<PublicKeyBytes, SignerError>;

    /// Sign a 32-byte digest with the currently active key.
    fn sign(&self, digest: &[u8; 32]) -> Result<Signature, SignerError>;

    /// Rotate to a freshly generated key, returning its identifier. Callers
    /// already holding a reference to this signer keep working: the next
    /// `sign` or `public_key` call simply observes the new key.
    fn rotate(&self) -> Result<String, SignerError>;
}

/// Whether `signature` over `digest` was produced by the holder of
/// `public_key` -- the counterpart to [`Signer::sign`] that needs no
/// `Signer` at all, since checking a signature takes only the public key a
/// verifier already holds (a peer's claim-verification key, per
/// `docs/protocol/peer-wire-spec.md` §1.1). Never returns an error: a
/// malformed public key or signature simply fails to verify, exactly like
/// one that verifies against the wrong digest.
pub fn verify(public_key: &PublicKeyBytes, digest: &[u8; 32], signature: &Signature) -> bool {
    verify_digest(public_key, digest, signature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LocalSigner;

    #[test]
    fn a_genuine_signature_verifies_against_its_signers_public_key() {
        let signer = LocalSigner::generate("claim-key");
        let digest = [7u8; 32];
        let signature = signer.sign(&digest).expect("sign");

        assert!(verify(
            &signer.public_key().expect("public key"),
            &digest,
            &signature
        ));
    }

    #[test]
    fn a_signature_does_not_verify_against_a_different_digest() {
        let signer = LocalSigner::generate("claim-key");
        let signature = signer.sign(&[7u8; 32]).expect("sign");

        assert!(!verify(
            &signer.public_key().expect("public key"),
            &[9u8; 32],
            &signature
        ));
    }

    #[test]
    fn a_signature_does_not_verify_against_a_different_signers_public_key() {
        let signer = LocalSigner::generate("claim-key");
        let other = LocalSigner::generate("other-key");
        let digest = [7u8; 32];
        let signature = signer.sign(&digest).expect("sign");

        assert!(!verify(
            &other.public_key().expect("public key"),
            &digest,
            &signature
        ));
    }
}
