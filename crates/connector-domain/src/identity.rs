//! Client-edge sender identity (`docs/protocol/client-edge-spec.md` §1.2,
//! issue #502). Pure, no I/O: the client edge crate extracts the raw
//! `ILP-Peer-Id` / `Authorization` / `ILP-Payment-Channel-Claim` strings off
//! the HTTP request and hands them to [`resolve_identity`], which is the one
//! place the identity policy is decided.
//!
//! A request identifies its sender in exactly one of two ways: a configured
//! peer authenticating with a bearer secret, or an anonymous sender given an
//! ephemeral identity derived from a plaintext claim's signer (or a fixed
//! one, absent that). Anonymity is a first-class path -- an unaffiliated
//! buyer pays a terminated route without ever registering with the
//! operator -- not a fallback for a request that merely omits credentials.

use serde_json::Value;
use thiserror::Error;

/// One configured client-edge identity: the id a request presents via
/// `ILP-Peer-Id` and the secret it must present via `Authorization: Bearer
/// <secret>` to authenticate as that identity. An empty `secret` means this
/// identity is permissionless -- a request presenting this id with no
/// `Authorization` header (equivalently, an empty bearer) authenticates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfiguredIdentity {
    pub id: String,
    pub secret: String,
}

/// Who a client-edge request identifies as. Either variant names a payer:
/// everything downstream that needs one (claim watermarks, rate limits,
/// injected payer headers) keys its state off [`SenderIdentity::id`], never
/// off which variant it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SenderIdentity {
    /// A configured identity's own id, presented and authenticated.
    Peer(String),
    /// No identity was presented. Carries `http:<signer>` when a plaintext
    /// claim named one, or the fixed `http:anon` otherwise.
    Anonymous(String),
}

impl SenderIdentity {
    /// The identity string everything downstream keys state against.
    pub fn id(&self) -> &str {
        match self {
            SenderIdentity::Peer(id) | SenderIdentity::Anonymous(id) => id,
        }
    }
}

/// A presented `ILP-Peer-Id` failed to authenticate
/// (`docs/protocol/client-edge-spec.md` §1.2: HTTP `401`). Distinct from any
/// payment outcome, and never downgraded to anonymous -- an identity that
/// was presented but rejected is a credential problem, not the absence of
/// one.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("identity '{peer_id}' failed to authenticate")]
pub struct UnauthorizedIdentity {
    pub peer_id: String,
}

/// The fixed anonymous identity: no `ILP-Peer-Id` was presented and either
/// no plaintext claim was present or none named a signer.
const ANONYMOUS: &str = "http:anon";

/// Resolve a client-edge request's [`SenderIdentity`]
/// (`docs/protocol/client-edge-spec.md` §1.2).
///
/// - `presented_peer_id` is the `ILP-Peer-Id` header, if present.
/// - `presented_secret` is the bearer credential the request presented --
///   the `Authorization: Bearer <secret>` header's value, or `""` when that
///   header is absent. The two are deliberately not distinguished: an
///   absent `Authorization` is an empty bearer (mirrors BTP's `secret: ''`
///   auth frame), never a distinct "no credential" state.
/// - `plaintext_claim` is the decoded `ILP-Payment-Channel-Claim` header's
///   bytes, if present. Consulted only when no peer id is presented, to
///   derive an anonymous sender's ephemeral identity from the claim's
///   signer. A wrapped-only claim (`ILP-Payment-Channel-Claim-Wrapped`) is
///   never passed here: unwrapping it would require already knowing the
///   identity authenticating the request, so it plays no part in deriving
///   one, and its absence from this signature is what enforces that.
pub fn resolve_identity(
    presented_peer_id: Option<&str>,
    presented_secret: &str,
    plaintext_claim: Option<&[u8]>,
    configured: &[ConfiguredIdentity],
) -> Result<SenderIdentity, UnauthorizedIdentity> {
    let Some(peer_id) = presented_peer_id else {
        return Ok(SenderIdentity::Anonymous(ephemeral_id(plaintext_claim)));
    };

    let authenticated = configured
        .iter()
        .any(|identity| identity.id == peer_id && identity.secret == presented_secret);

    if authenticated {
        Ok(SenderIdentity::Peer(peer_id.to_string()))
    } else {
        Err(UnauthorizedIdentity {
            peer_id: peer_id.to_string(),
        })
    }
}

/// Best-effort extraction of a claim-bound identity for an anonymous
/// request. Never fails: an absent, malformed, or signer-less claim all
/// fall back to [`ANONYMOUS`], since this is identity derivation only --
/// full claim validation is a separate concern (issue #504) that runs, if
/// at all, only after identity is already resolved.
fn ephemeral_id(plaintext_claim: Option<&[u8]>) -> String {
    let signer = plaintext_claim
        .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok())
        .and_then(|claim| {
            claim
                .get("signerAddress")
                .or_else(|| claim.get("signerPublicKey"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });

    match signer {
        Some(signer) => format!("http:{signer}"),
        None => ANONYMOUS.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(id: &str, secret: &str) -> ConfiguredIdentity {
        ConfiguredIdentity {
            id: id.to_string(),
            secret: secret.to_string(),
        }
    }

    #[test]
    fn a_configured_peer_presenting_its_identity_and_correct_secret_is_recognised() {
        let configured = vec![identity("peer-a", "s3cr3t")];
        let resolved = resolve_identity(Some("peer-a"), "s3cr3t", None, &configured).unwrap();
        assert_eq!(resolved, SenderIdentity::Peer("peer-a".to_string()));
        assert_eq!(resolved.id(), "peer-a");
    }

    #[test]
    fn a_configured_identity_permitting_an_empty_secret_is_accepted_with_the_credential_absent() {
        let configured = vec![identity("peer-a", "")];
        let resolved = resolve_identity(Some("peer-a"), "", None, &configured).unwrap();
        assert_eq!(resolved, SenderIdentity::Peer("peer-a".to_string()));
    }

    #[test]
    fn a_presented_identity_with_the_wrong_secret_is_unauthorized_not_anonymous() {
        let configured = vec![identity("peer-a", "s3cr3t")];
        let result = resolve_identity(Some("peer-a"), "wrong", None, &configured);
        assert_eq!(
            result,
            Err(UnauthorizedIdentity {
                peer_id: "peer-a".to_string()
            })
        );
    }

    #[test]
    fn a_presented_identity_that_names_no_configured_peer_is_unauthorized() {
        let result = resolve_identity(Some("peer-a"), "", None, &[]);
        assert_eq!(
            result,
            Err(UnauthorizedIdentity {
                peer_id: "peer-a".to_string()
            })
        );
    }

    #[test]
    fn a_request_with_no_identity_and_no_claim_is_the_fixed_anonymous_identity() {
        let resolved = resolve_identity(None, "", None, &[]).unwrap();
        assert_eq!(resolved, SenderIdentity::Anonymous(ANONYMOUS.to_string()));
    }

    #[test]
    fn an_anonymous_senders_ephemeral_identity_derives_from_the_plaintext_claims_signer_address() {
        let claim = br#"{"signerAddress":"0xabc123"}"#;
        let resolved = resolve_identity(None, "", Some(claim), &[]).unwrap();
        assert_eq!(
            resolved,
            SenderIdentity::Anonymous("http:0xabc123".to_string())
        );
    }

    #[test]
    fn an_anonymous_senders_ephemeral_identity_derives_from_the_plaintext_claims_signer_public_key()
    {
        let claim = br#"{"signerPublicKey":"abc123base58"}"#;
        let resolved = resolve_identity(None, "", Some(claim), &[]).unwrap();
        assert_eq!(
            resolved,
            SenderIdentity::Anonymous("http:abc123base58".to_string())
        );
    }

    #[test]
    fn a_malformed_plaintext_claim_falls_back_to_the_fixed_anonymous_identity() {
        let resolved = resolve_identity(None, "", Some(b"not json"), &[]).unwrap();
        assert_eq!(resolved, SenderIdentity::Anonymous(ANONYMOUS.to_string()));
    }

    #[test]
    fn a_plaintext_claim_naming_no_signer_falls_back_to_the_fixed_anonymous_identity() {
        let claim = br#"{"messageId":"abc"}"#;
        let resolved = resolve_identity(None, "", Some(claim), &[]).unwrap();
        assert_eq!(resolved, SenderIdentity::Anonymous(ANONYMOUS.to_string()));
    }

    /// AC: "A request carrying only a wrapped claim gets the fixed
    /// anonymous identity, not one derived from unwrapping." This function
    /// never sees the wrapped claim header at all -- only `plaintext_claim`
    /// -- so a caller that has only a wrapped claim to offer (and correctly
    /// passes `None` here rather than attempting to unwrap it first) always
    /// gets the fixed identity, by construction.
    #[test]
    fn only_a_wrapped_claim_present_is_equivalent_to_no_claim_at_all() {
        let resolved = resolve_identity(None, "", None, &[]).unwrap();
        assert_eq!(resolved, SenderIdentity::Anonymous(ANONYMOUS.to_string()));
    }
}
