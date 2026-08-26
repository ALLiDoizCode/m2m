//! One contract suite, run against every [`Signer`] implementation with
//! identical assertions (ADR 0007, issue #419 AC). `run_signer_contract` is
//! the suite; `local_signer_upholds_the_contract` and
//! `kms_signer_upholds_the_contract` below are what makes it a legitimate
//! test subject for each implementation rather than a description of one
//! of them.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use crate::kms::{InMemoryKmsBackend, KmsSigner};
use crate::local::LocalSigner;
use crate::signer::{verify, Signer};

fn recovers_to_own_public_key(signer: &dyn Signer, digest: &[u8; 32]) {
    let public_key = signer.public_key().expect("public key");
    let signature = signer.sign(digest).expect("sign");

    assert!(
        verify(&public_key, digest, &signature),
        "signature must verify against the signer's own public key"
    );
}

fn run_signer_contract(make_signer: impl Fn() -> Arc<dyn Signer>) {
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

    // Two independent signers derive the same shared secret from each
    // other's public key (issue #524) -- ECDH's commutativity is the whole
    // point of key agreement: neither side ever transmits the secret
    // itself, only a public key.
    let counterparty = make_signer();
    let shared_from_signer = signer.ecdh(&counterparty.public_key().expect("public key"));
    let shared_from_counterparty = counterparty.ecdh(&signer.public_key().expect("public key"));
    assert_eq!(shared_from_signer, shared_from_counterparty);
    let shared_from_signer = shared_from_signer.expect("ecdh");

    // Rotation changes the derived secret too -- it depends on the active
    // key, exactly like `sign`/`public_key` do.
    signer.rotate().expect("rotate");
    let shared_after_rotation = signer
        .ecdh(&counterparty.public_key().expect("public key"))
        .expect("ecdh");
    assert_ne!(shared_from_signer, shared_after_rotation);

    // Rotation does not stop the node: a concurrent signer keeps signing
    // successfully across a rotation happening on another thread.
    let signer_for_writer = signer.clone();
    let signer_for_reader = signer.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_reader = stop.clone();
    // The reader sends once it has signed, and the writer blocks on that
    // before rotating -- so the reader's loop cannot be empty and the
    // rotations cannot all land before the reader ever runs. A channel
    // rather than a spin flag: the writer parks instead of burning a core
    // against the very thread it is waiting for. See the comment on the
    // assertion below for why this handshake exists at all.
    let (reader_signed, reader_signed_rx) = std::sync::mpsc::channel::<()>();

    let writer = thread::spawn(move || {
        reader_signed_rx
            .recv()
            .expect("the reader signs before the writer rotates");
        for _ in 0..20 {
            signer_for_writer.rotate().expect("rotate under contention");
        }
        stop.store(true, Ordering::SeqCst);
    });

    let reader = thread::spawn(move || {
        let mut signed_at_least_once = false;
        loop {
            signer_for_reader
                .sign(&digest)
                .expect("sign must not fail during rotation");
            if !signed_at_least_once {
                signed_at_least_once = true;
                reader_signed.send(()).expect("the writer is waiting");
            }
            if stop_for_reader.load(Ordering::SeqCst) {
                break;
            }
        }
        // One final sign after the writer is done, proving the signer is
        // still usable post-rotation.
        signer_for_reader
            .sign(&digest)
            .expect("sign must succeed after rotation settles");
        // Now a real claim rather than a hopeful one. Before the handshake
        // above, a writer that finished all twenty rotations before this
        // thread was first scheduled left `stop` already set, so the `while`
        // never entered its body and this fired on an empty loop -- a
        // scheduling accident reported as a signer defect, on whichever
        // unrelated PR happened to run on a busy runner.
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
