//! **What a route-identity statement is signed over, and how it is checked**
//! (issue #1026). This is the one module that decides the encoding; the
//! shape it signs is `connector_domain::RouteIdentity`, and every place
//! that shape is carried treats it as opaque.
//!
//! # Why this module exists apart from the plumbing
//!
//! Issue #1026's recommendation is that the connector terminating a route
//! signs its own `(prefix, identity key)` and every forwarding hop relays
//! that statement verbatim. The *carriage* of the statement (the identity
//! endpoint, the two greetings, the relay cache) does not depend on what
//! the bytes under the signature are. Keeping the digest and the encoding
//! here means a different preimage -- a typed EIP-712 struct, a Nostr
//! event, an added `expires` -- is a change to this file and to nothing
//! else. The choice made here is deliberately the plainest one that has the
//! required properties, so that it is easy to replace rather than hard to
//! argue with.
//!
//! # The properties, and what enforces each
//!
//! - **A hop cannot forge a statement for a key it does not hold**: the
//!   signature is made with the private half of the very key the statement
//!   names, and [`verify_route_identity`] checks it against that key -- a
//!   self-signed binding, never a key the relay chose.
//! - **A statement for one prefix cannot be replayed as another's**: the
//!   prefix is under the signature, length-prefixed so `("g.a", "b")` and
//!   `("g.", "ab")` cannot share a preimage.
//! - **A statement cannot be confused with any other signature this key
//!   makes**: the preimage carries a domain tag no other digest in this
//!   crate starts with (the same reasoning [`crate::claim_state_challenge`]
//!   gives for its tag), so a captured route-identity signature is not a
//!   claim, a challenge or an announce, and none of those is a route
//!   identity.
//!
//! What is *not* here, on purpose: an expiry or a nonce. The statement
//! grants nothing and moves nothing -- it names a key to encrypt to -- so
//! the only thing a stale one can do is send a payload to a key its owner
//! has since rotated away from, which fails closed at the terminating
//! connector exactly as an unreadable wrap does today. If rotation turns
//! out to need it, `expires` goes under the tag here.

use sha2::{Digest as _, Sha256};

use crate::signer::{verify, PublicKeyBytes, Signature, Signer};
use crate::SignerError;

/// The domain tag every route-identity digest begins with. Versioned so a
/// later encoding can coexist with statements made under this one.
pub const ROUTE_IDENTITY_DOMAIN_TAG: &[u8] = b"toon-route-identity-v1";

/// A route-identity signature on the wire: `r || s || v`, 65 bytes, as
/// [`Signature::to_bytes`] lays it out.
pub type RouteIdentitySignature = [u8; 65];

/// The 32-byte digest a route-identity signature is made over:
/// `sha256(tag || u16_be(len(prefix)) || prefix || public_key)`.
///
/// Exposed so a test, or a client in another language, can produce and
/// check exactly what [`sign_route_identity`] signs and
/// [`verify_route_identity`] verifies.
#[must_use]
pub fn route_identity_digest(prefix: &str, public_key: &PublicKeyBytes) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(ROUTE_IDENTITY_DOMAIN_TAG);
    // An ILP address is bounded far below u16::MAX; a longer prefix is
    // truncated at the length word and so cannot verify, which is the
    // right answer for something that is not an ILP address.
    let length = u16::try_from(prefix.len()).unwrap_or(u16::MAX);
    hasher.update(length.to_be_bytes());
    hasher.update(&prefix.as_bytes()[..usize::from(length).min(prefix.len())]);
    hasher.update(public_key);
    hasher.finalize().into()
}

/// Sign `prefix` with `signer`'s active identity key, binding the prefix to
/// that key. Returns the key the statement names alongside the signature,
/// since a caller building a `RouteIdentity` needs both and must not fetch
/// the key separately -- a rotation between the two calls would produce a
/// statement that verifies against no key at all.
pub fn sign_route_identity(
    signer: &dyn Signer,
    prefix: &str,
) -> Result<(PublicKeyBytes, RouteIdentitySignature), SignerError> {
    let public_key = signer.public_key()?;
    let signature = signer.sign(&route_identity_digest(prefix, &public_key))?;
    Ok((public_key, signature.to_bytes()))
}

/// Whether `signature` is `public_key`'s own statement that payloads to
/// `prefix` are to be sealed to it. Never errors: a malformed signature
/// fails to verify, exactly like a genuine one over a different prefix.
#[must_use]
pub fn verify_route_identity(
    prefix: &str,
    public_key: &PublicKeyBytes,
    signature: &RouteIdentitySignature,
) -> bool {
    let Some(signature) = Signature::from_bytes(signature) else {
        return false;
    };
    verify(
        public_key,
        &route_identity_digest(prefix, public_key),
        &signature,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LocalSigner;

    fn signer(seed: u8) -> LocalSigner {
        LocalSigner::from_secret_bytes("route-identity-test", [seed; 32]).expect("valid seed")
    }

    #[test]
    fn a_statement_verifies_against_the_key_that_made_it() {
        let signer = signer(11);
        let (public_key, signature) = sign_route_identity(&signer, "g.example.app").expect("signs");
        assert_eq!(public_key, signer.public_key().expect("public key"));
        assert!(verify_route_identity(
            "g.example.app",
            &public_key,
            &signature
        ));
    }

    #[test]
    fn a_statement_for_one_prefix_is_not_a_statement_for_another() {
        let signer = signer(11);
        let (public_key, signature) = sign_route_identity(&signer, "g.example.app").expect("signs");
        assert!(!verify_route_identity(
            "g.example.other",
            &public_key,
            &signature
        ));
        // The length prefix is what keeps these two apart.
        let (key_a, sig_a) = sign_route_identity(&signer, "g.a").expect("signs");
        assert!(!verify_route_identity("g.", &key_a, &sig_a));
    }

    #[test]
    fn a_hop_cannot_relabel_a_statement_with_its_own_key() {
        // The forwarding hop holds seed 12; the terminating connector holds
        // seed 11. The hop cannot take the far end's statement and swap in
        // its own key, and cannot mint one naming the far end's key.
        let far_end = signer(11);
        let hop = signer(12);
        let (far_key, far_sig) = sign_route_identity(&far_end, "g.example.app").expect("signs");
        let hop_key = hop.public_key().expect("public key");
        assert!(!verify_route_identity("g.example.app", &hop_key, &far_sig));
        let (_, hop_sig) = sign_route_identity(&hop, "g.example.app").expect("signs");
        assert!(!verify_route_identity("g.example.app", &far_key, &hop_sig));
    }

    #[test]
    fn a_route_identity_digest_is_not_any_other_digest_this_crate_makes() {
        // Same key, same bytes hashed without the tag: different digest, so
        // a signature over one never verifies as the other.
        let public_key = signer(11).public_key().expect("public key");
        let tagged = route_identity_digest("g.example.app", &public_key);
        let mut untagged = Sha256::new();
        untagged.update(13u16.to_be_bytes());
        untagged.update(b"g.example.app");
        untagged.update(public_key);
        let untagged: [u8; 32] = untagged.finalize().into();
        assert_ne!(tagged, untagged);
        assert!(tagged != [0u8; 32]);
    }

    #[test]
    fn a_malformed_signature_fails_to_verify_rather_than_erroring() {
        let public_key = signer(11).public_key().expect("public key");
        assert!(!verify_route_identity(
            "g.example.app",
            &public_key,
            &[0u8; 65]
        ));
        assert!(!verify_route_identity(
            "g.example.app",
            &public_key,
            &[0xffu8; 65]
        ));
    }
}
