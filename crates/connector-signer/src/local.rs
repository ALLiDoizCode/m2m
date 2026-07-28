use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use libsecp256k1::{PublicKey, SecretKey};

use crate::crypto::{ecdh_x_coordinate, generate_keypair, sign_digest};
use crate::error::SignerError;
use crate::signer::{PublicKeyBytes, Signature, Signer};

struct ActiveKey {
    key_id: String,
    secret: SecretKey,
    public: PublicKey,
}

/// A [`Signer`] that holds a secp256k1 key pair directly in process memory.
///
/// This is the "local key" implementation the signer port requires: no
/// service boundary, no network call, key material never leaves the
/// process. Rotation swaps a fresh key pair in behind a lock so a caller
/// signing concurrently never observes anything but a fully-formed key.
pub struct LocalSigner {
    base_id: String,
    generation: AtomicU64,
    active: RwLock<ActiveKey>,
}

impl LocalSigner {
    /// Generate a fresh key pair and hold it under `key_id`.
    pub fn generate(key_id: impl Into<String>) -> Self {
        let base_id = key_id.into();
        let (secret, public) = generate_keypair();
        LocalSigner {
            active: RwLock::new(ActiveKey {
                key_id: base_id.clone(),
                secret,
                public,
            }),
            base_id,
            generation: AtomicU64::new(0),
        }
    }

    /// Load an existing 32-byte secret key rather than generating one.
    pub fn from_secret_bytes(
        key_id: impl Into<String>,
        secret_bytes: [u8; 32],
    ) -> Result<Self, SignerError> {
        let secret = SecretKey::parse(&secret_bytes).map_err(|_| SignerError::InvalidKey)?;
        let public = PublicKey::from_secret_key(&secret);
        let base_id = key_id.into();
        Ok(LocalSigner {
            active: RwLock::new(ActiveKey {
                key_id: base_id.clone(),
                secret,
                public,
            }),
            base_id,
            generation: AtomicU64::new(0),
        })
    }
}

impl Signer for LocalSigner {
    fn key_id(&self) -> String {
        self.active
            .read()
            .expect("LocalSigner lock poisoned")
            .key_id
            .clone()
    }

    fn public_key(&self) -> Result<PublicKeyBytes, SignerError> {
        Ok(self
            .active
            .read()
            .expect("LocalSigner lock poisoned")
            .public
            .serialize())
    }

    fn sign(&self, digest: &[u8; 32]) -> Result<Signature, SignerError> {
        let guard = self.active.read().expect("LocalSigner lock poisoned");
        Ok(sign_digest(&guard.secret, digest))
    }

    fn rotate(&self) -> Result<String, SignerError> {
        let (secret, public) = generate_keypair();
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let new_id = format!("{}#{generation}", self.base_id);
        let mut guard = self.active.write().expect("LocalSigner lock poisoned");
        guard.secret = secret;
        guard.public = public;
        guard.key_id = new_id.clone();
        Ok(new_id)
    }

    fn ecdh(&self, peer_public_key: &PublicKeyBytes) -> Result<[u8; 32], SignerError> {
        let peer_public = PublicKey::parse(peer_public_key).map_err(|_| SignerError::InvalidKey)?;
        let guard = self.active.read().expect("LocalSigner lock poisoned");
        ecdh_x_coordinate(&guard.secret, &peer_public).ok_or(SignerError::InvalidKey)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_public_key_is_uncompressed() {
        let signer = LocalSigner::generate("evm-claim-key");
        let public_key = signer.public_key().expect("public key");
        assert_eq!(public_key[0], 0x04);
    }

    #[test]
    fn rotate_changes_key_id_and_public_key() {
        let signer = LocalSigner::generate("evm-claim-key");
        let before_id = signer.key_id();
        let before_pk = signer.public_key().expect("public key");

        let new_id = signer.rotate().expect("rotate");

        assert_ne!(new_id, before_id);
        assert_eq!(signer.key_id(), new_id);
        assert_ne!(signer.public_key().expect("public key"), before_pk);
    }

    #[test]
    fn from_secret_bytes_rejects_zero_key() {
        let result = LocalSigner::from_secret_bytes("bad", [0u8; 32]);
        assert!(matches!(result, Err(SignerError::InvalidKey)));
    }
}
