use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};

use libsecp256k1::{Message, PublicKey, SecretKey};
use rand::rngs::OsRng;

use crate::error::SignerError;
use crate::signer::{PublicKeyBytes, Signature, Signer};

/// The boundary a key management service is reached through: every
/// operation is addressed by `key_id` and only signatures and public keys
/// ever cross it — secret key material never does. A real backend (AWS
/// KMS, GCP KMS, an HSM) implements this trait by making a network call
/// per method; [`InMemoryKmsBackend`] is the fake used to exercise the
/// contract in this repository, where no such service is reachable.
pub trait KmsBackend: Send + Sync {
    fn sign(&self, key_id: &str, digest: &[u8; 32]) -> Result<Signature, SignerError>;
    fn public_key(&self, key_id: &str) -> Result<PublicKeyBytes, SignerError>;
    /// Roll `key_id` to a newly provisioned key and return its identifier.
    /// The old key remains resolvable by callers that still hold it; only
    /// the signer's active pointer moves.
    fn rotate_key(&self, key_id: &str) -> Result<String, SignerError>;
}

/// A [`Signer`] backed by a [`KmsBackend`]: the "key management service"
/// implementation the signer port requires. Key material lives entirely
/// behind `backend`; this type only ever holds the active key's
/// identifier, swapped under a lock so rotation never stops signing.
pub struct KmsSigner {
    backend: Box<dyn KmsBackend>,
    active_key_id: RwLock<String>,
}

impl KmsSigner {
    pub fn new(backend: Box<dyn KmsBackend>, key_id: impl Into<String>) -> Self {
        KmsSigner {
            backend,
            active_key_id: RwLock::new(key_id.into()),
        }
    }
}

impl Signer for KmsSigner {
    fn key_id(&self) -> String {
        self.active_key_id
            .read()
            .expect("KmsSigner lock poisoned")
            .clone()
    }

    fn public_key(&self) -> Result<PublicKeyBytes, SignerError> {
        self.backend.public_key(&self.key_id())
    }

    fn sign(&self, digest: &[u8; 32]) -> Result<Signature, SignerError> {
        self.backend.sign(&self.key_id(), digest)
    }

    fn rotate(&self) -> Result<String, SignerError> {
        let mut guard = self.active_key_id.write().expect("KmsSigner lock poisoned");
        let new_id = self.backend.rotate_key(&guard)?;
        *guard = new_id.clone();
        Ok(new_id)
    }
}

struct StoredKey {
    secret: SecretKey,
    public: PublicKey,
}

/// An in-memory stand-in for a real key management service. It upholds
/// exactly the [`KmsBackend`] contract a real backend would: keys are
/// addressed by opaque `key_id`, secret material never leaves `sign`'s
/// return value (a signature, not the key), and `rotate_key` provisions a
/// new key server-side and returns its id.
#[derive(Default)]
pub struct InMemoryKmsBackend {
    keys: Mutex<HashMap<String, StoredKey>>,
    generation: AtomicU64,
}

impl InMemoryKmsBackend {
    pub fn new() -> Self {
        InMemoryKmsBackend::default()
    }

    /// Provision `key_id` with a freshly generated key pair, as a real KMS
    /// would when a key is first created. Required before it can be signed
    /// with or read.
    pub fn provision(&self, key_id: impl Into<String>) -> Result<(), SignerError> {
        let (secret, public) = generate_keypair();
        self.keys
            .lock()
            .expect("InMemoryKmsBackend lock poisoned")
            .insert(key_id.into(), StoredKey { secret, public });
        Ok(())
    }

    fn with_key<T>(&self, key_id: &str, f: impl FnOnce(&StoredKey) -> T) -> Result<T, SignerError> {
        let keys = self.keys.lock().expect("InMemoryKmsBackend lock poisoned");
        let key = keys
            .get(key_id)
            .ok_or_else(|| SignerError::KeyNotFound(key_id.to_string()))?;
        Ok(f(key))
    }
}

fn generate_keypair() -> (SecretKey, PublicKey) {
    let mut rng = OsRng;
    let secret = SecretKey::random(&mut rng);
    let public = PublicKey::from_secret_key(&secret);
    (secret, public)
}

impl KmsBackend for InMemoryKmsBackend {
    fn sign(&self, key_id: &str, digest: &[u8; 32]) -> Result<Signature, SignerError> {
        self.with_key(key_id, |key| {
            let message = Message::parse(digest);
            let (sig, recovery_id) = libsecp256k1::sign(&message, &key.secret);
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
        })
    }

    fn public_key(&self, key_id: &str) -> Result<PublicKeyBytes, SignerError> {
        self.with_key(key_id, |key| key.public.serialize())
    }

    fn rotate_key(&self, key_id: &str) -> Result<String, SignerError> {
        let (secret, public) = generate_keypair();
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let new_id = format!("{key_id}#{generation}");
        self.keys
            .lock()
            .expect("InMemoryKmsBackend lock poisoned")
            .insert(new_id.clone(), StoredKey { secret, public });
        Ok(new_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signer_with_provisioned_key(key_id: &str) -> KmsSigner {
        let backend = InMemoryKmsBackend::new();
        backend.provision(key_id).expect("provision");
        KmsSigner::new(Box::new(backend), key_id)
    }

    #[test]
    fn unknown_key_id_is_reported_not_panicked() {
        let backend = InMemoryKmsBackend::new();
        let signer = KmsSigner::new(Box::new(backend), "never-provisioned");
        let err = signer.public_key().unwrap_err();
        assert_eq!(err, SignerError::KeyNotFound("never-provisioned".into()));
    }

    #[test]
    fn rotate_provisions_a_new_key_behind_the_backend() {
        let signer = signer_with_provisioned_key("prod-claim-key");
        let before_pk = signer.public_key().expect("public key");

        let new_id = signer.rotate().expect("rotate");

        assert_eq!(signer.key_id(), new_id);
        assert_ne!(signer.public_key().expect("public key"), before_pk);
    }
}
