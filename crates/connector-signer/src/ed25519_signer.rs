//! The ed25519 signer port (issue #742): the Solana counterpart of
//! [`crate::Signer`]. A peer channel's outbound claim on Solana is signed
//! with an ed25519 key over `crate::solana_balance_proof_message`'s 48
//! bytes, never recovered like a secp256k1 signature -- kept as its own
//! trait rather than folded into [`crate::Signer`], the same "do not merge
//! the two chains behind one abstraction" rule
//! `connector_runtime::ClaimBook` holds `ChannelDomain`/`SolanaChannel` to
//! (issue #732).
//!
//! Only [`LocalEd25519Signer`] exists today, holding key material directly
//! in process memory. There is no KMS-backed implementation yet -- matching
//! how a Solana peer channel has no config surface to load one from either;
//! wiring either into `connector-config`/`connector-cli` is out of this
//! issue's scope, which is signing capability, not deployment.

use ed25519_dalek::{Keypair, PublicKey, SecretKey, Signer as DalekSigner};
use rand::rngs::OsRng;

use crate::error::SignerError;

/// Sign a Solana peer claim's balance-proof message with this connector's
/// own identity key. The counterpart of [`crate::Signer::sign`], over the
/// message directly rather than a digest -- ed25519 signs the message
/// itself, with no separate hashing step the way an EIP-712 digest has one.
///
/// `message` is a plain slice rather than `solana_balance_proof_message`'s
/// fixed 48 bytes (issue #1011) so the same key can also sign a
/// claim-state challenge (`crate::solana_claim_state_challenge_message`),
/// which is a different length -- both are still ordinary ed25519 signing
/// over whatever bytes the caller already built.
pub trait Ed25519Signer: Send + Sync {
    /// The raw 32-byte public key of the currently active key.
    fn public_key(&self) -> [u8; 32];

    /// Sign `message` with the currently active key.
    fn sign(&self, message: &[u8]) -> [u8; 64];
}

/// A [`Ed25519Signer`] that holds an ed25519 key pair directly in process
/// memory -- the Solana counterpart of [`crate::LocalSigner`].
pub struct LocalEd25519Signer {
    keypair: Keypair,
}

impl LocalEd25519Signer {
    /// Generate a fresh key pair.
    #[must_use]
    pub fn generate() -> Self {
        let mut rng = OsRng;
        LocalEd25519Signer {
            keypair: Keypair::generate(&mut rng),
        }
    }

    /// Load an existing 32-byte seed rather than generating one.
    pub fn from_secret_bytes(seed: [u8; 32]) -> Result<Self, SignerError> {
        let secret = SecretKey::from_bytes(&seed).map_err(|_| SignerError::InvalidKey)?;
        let public = PublicKey::from(&secret);
        Ok(LocalEd25519Signer {
            keypair: Keypair { secret, public },
        })
    }
}

impl Ed25519Signer for LocalEd25519Signer {
    fn public_key(&self) -> [u8; 32] {
        self.keypair.public.to_bytes()
    }

    fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.keypair.sign(message).to_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::verify_solana_balance_proof;

    #[test]
    fn generated_signers_have_distinct_keys() {
        let a = LocalEd25519Signer::generate();
        let b = LocalEd25519Signer::generate();
        assert_ne!(a.public_key(), b.public_key());
    }

    #[test]
    fn from_secret_bytes_is_deterministic() {
        let a = LocalEd25519Signer::from_secret_bytes([7u8; 32]).unwrap();
        let b = LocalEd25519Signer::from_secret_bytes([7u8; 32]).unwrap();
        assert_eq!(a.public_key(), b.public_key());
    }

    #[test]
    fn a_signed_balance_proof_verifies_against_its_signers_own_public_key() {
        let signer = LocalEd25519Signer::from_secret_bytes([3u8; 32]).unwrap();
        let channel_account = [9u8; 32];
        let signature = signer.sign(&crate::solana_balance_proof_message(
            &channel_account,
            4,
            500,
        ));

        assert!(verify_solana_balance_proof(
            &channel_account,
            4,
            500,
            &signature,
            &signer.public_key()
        ));
    }

    #[test]
    fn a_signed_balance_proof_does_not_verify_against_a_different_signers_key() {
        let signer = LocalEd25519Signer::from_secret_bytes([3u8; 32]).unwrap();
        let other = LocalEd25519Signer::from_secret_bytes([4u8; 32]).unwrap();
        let channel_account = [9u8; 32];
        let signature = signer.sign(&crate::solana_balance_proof_message(
            &channel_account,
            4,
            500,
        ));

        assert!(!verify_solana_balance_proof(
            &channel_account,
            4,
            500,
            &signature,
            &other.public_key()
        ));
    }

    /// Issue #1011: the same signer signs a claim-state challenge, whose
    /// message is a different length from a balance proof's fixed 48
    /// bytes -- proving `sign` genuinely takes a plain slice now, not just
    /// a 48-byte array coerced into one.
    #[test]
    fn the_same_signer_also_signs_a_differently_sized_claim_state_challenge() {
        let signer = LocalEd25519Signer::from_secret_bytes([5u8; 32]).unwrap();
        let channel_account = [9u8; 32];
        let message = crate::solana_claim_state_challenge_message(&channel_account, 1_800_000_000);
        assert_ne!(
            message.len(),
            48,
            "the challenge message must not be 48 bytes"
        );

        let signature = signer.sign(&message);

        assert!(crate::verify_solana_claim_state_challenge(
            &channel_account,
            1_800_000_000,
            &signature,
            &signer.public_key(),
        ));
    }
}
