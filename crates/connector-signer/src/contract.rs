//! One contract suite, run against every [`Signer`] implementation with
//! identical assertions (ADR 0007, issue #419 AC). `run_signer_contract` is
//! the suite; `local_signer_upholds_the_contract` and
//! `kms_signer_upholds_the_contract` below are what makes it a legitimate
//! test subject for each implementation rather than a description of one
//! of them.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use libsecp256k1::{Message, PublicKey, RecoveryId, Signature as RawSignature};

use crate::kms::{InMemoryKmsBackend, KmsSigner};
use crate::local::LocalSigner;
use crate::signer::Signer;

fn recovers_to_own_public_key(signer: &dyn Signer, digest: &[u8; 32]) {
    let public_key = signer.public_key().expect("public key");
    let signature = signer.sign(digest).expect("sign");

    let mut serialized = [0u8; 64];
    serialized[..32].copy_from_slice(&signature.r);
    serialized[32..].copy_from_slice(&signature.s);
    let raw_signature = RawSignature::parse_standard(&serialized).expect("valid signature shape");
    let recovery_id = RecoveryId::parse(signature.recovery_id).expect("valid recovery id");
    let message = Message::parse(digest);

    let recovered = libsecp256k1::recover(&message, &raw_signature, &recovery_id)
        .expect("signature recovers a public key");
    let expected = PublicKey::parse(&public_key).expect("valid public key");
    assert_eq!(
        recovered, expected,
        "signature must recover to the signer's own public key"
    );
    assert!(libsecp256k1::verify(&message, &raw_signature, &expected));
}

fn run_signer_contract(make_signer: impl FnOnce() -> Arc<dyn Signer>) {
    let signer = make_signer();
    let digest = [7u8; 32];

    // Public key is the uncompressed secp256k1 encoding.
    let public_key = signer.public_key().expect("public key");
    assert_eq!(public_key[0], 0x04);

    // A signature recovers to the key that produced it.
    recovers_to_own_public_key(signer.as_ref(), &digest);

    // Signing is deterministic: the same digest under the same key always
    // produces the same signature (RFC 6979), so a caller can tell "this
    // is the same claim, signed again" apart from "this is a new claim."
    let first = signer.sign(&digest).expect("sign");
    let second = signer.sign(&digest).expect("sign");
    assert_eq!(first, second);

    // Rotation changes both the key id and the public key, and a digest
    // signed afterward recovers to the new key, not the old one.
    let key_id_before = signer.key_id();
    let public_key_before = signer.public_key().expect("public key");
    let new_key_id = signer.rotate().expect("rotate");
    assert_ne!(new_key_id, key_id_before);
    assert_eq!(signer.key_id(), new_key_id);
    assert_ne!(signer.public_key().expect("public key"), public_key_before);
    recovers_to_own_public_key(signer.as_ref(), &digest);

    // Rotation does not stop the node: a concurrent signer keeps signing
    // successfully across a rotation happening on another thread.
    let signer_for_writer = signer.clone();
    let signer_for_reader = signer.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_reader = stop.clone();

    let writer = thread::spawn(move || {
        for _ in 0..20 {
            signer_for_writer.rotate().expect("rotate under contention");
        }
        stop.store(true, Ordering::SeqCst);
    });

    let reader = thread::spawn(move || {
        let mut signed_at_least_once = false;
        while !stop_for_reader.load(Ordering::SeqCst) {
            signer_for_reader
                .sign(&digest)
                .expect("sign must not fail during rotation");
            signed_at_least_once = true;
        }
        // One final sign after the writer is done, proving the signer is
        // still usable post-rotation.
        signer_for_reader
            .sign(&digest)
            .expect("sign must succeed after rotation settles");
        assert!(signed_at_least_once);
    });

    writer.join().expect("writer thread panicked");
    reader.join().expect("reader thread panicked");
}

#[test]
fn local_signer_upholds_the_contract() {
    run_signer_contract(|| Arc::new(LocalSigner::generate("contract-suite-key")));
}

#[test]
fn kms_signer_upholds_the_contract() {
    run_signer_contract(|| {
        let backend = InMemoryKmsBackend::new();
        backend.provision("contract-suite-key").expect("provision");
        Arc::new(KmsSigner::new(Box::new(backend), "contract-suite-key"))
    });
}
