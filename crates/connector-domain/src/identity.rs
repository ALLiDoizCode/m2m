//! Client-edge sender identity (`docs/protocol/client-edge-spec.md` §1.2,
//! issue #502). Pure, no I/O: the client edge crate extracts the raw
//! `ILP-Peer-Id`/`Authorization` header values off the HTTP request, plus
//! (when one is available) the already-parsed [`crate::client_claim::ClientClaim`]'s
//! self-declared signer, and hands them to [`resolve_identity`], the one
//! place the identity policy is decided ([`anonymous_identity`] is that
//! function's own no-peer-id branch, exposed so a caller that has already
//! established there is no peer id to authenticate can take it directly).
//!
//! A request identifies its sender in one of two ways: a configured peer
//! authenticating with a bearer secret, or an anonymous sender given an
//! ephemeral identity derived from a plaintext claim's already-parsed signer
//! (or a fixed one, absent that). Anonymity is a first-class path -- an
//! unaffiliated buyer pays a terminated route without ever registering with
//! the operator -- not a fallback for a request that merely omits
//! credentials.

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
/// everything downstream that needs one keys its state off
/// [`SenderIdentity::id`], never off which variant it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SenderIdentity {
    /// A configured identity's own id, presented and authenticated.
    Peer(String),
    /// No identity was presented. Carries `http:<signer>` when a plaintext
    /// claim named one, or the fixed [`ANONYMOUS`] otherwise.
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

/// The fixed anonymous identity (client-edge-spec.md §1.2): no
/// `ILP-Peer-Id` was presented and either no plaintext claim was present or
/// none named a signer.
pub const ANONYMOUS: &str = "http:anon";

/// Resolve a client-edge request's [`SenderIdentity`]
/// (`docs/protocol/client-edge-spec.md` §1.2).
///
/// - `presented_peer_id` is the `ILP-Peer-Id` header, if present.
/// - `presented_secret` is the bearer credential the request presented --
///   the `Authorization: Bearer <secret>` header's value, or `""` when that
///   header is absent. The two are deliberately not distinguished: an
///   absent `Authorization` is an empty bearer (mirrors BTP's `secret: ''`
///   auth frame), never a distinct "no credential" state.
/// - `claim_signer` is a plaintext `ILP-Payment-Channel-Claim` header's
///   already-parsed, self-declared signer (`ClientClaim::signer`), if the
///   request presented one. Consulted only when no peer id is presented, to
///   derive an anonymous sender's ephemeral identity -- never re-parsed from
///   the claim JSON here, since the client edge has already done that
///   parsing once to admit the claim. A wrapped-only claim
///   (`ILP-Payment-Channel-Claim-Wrapped`) is never passed here: unwrapping
///   it would require already knowing the identity authenticating the
///   request, so it plays no part in deriving one, and its absence from
///   this signature is what enforces that.
pub fn resolve_identity(
    presented_peer_id: Option<&str>,
    presented_secret: &str,
    claim_signer: Option<&str>,
    configured: &[ConfiguredIdentity],
) -> Result<SenderIdentity, UnauthorizedIdentity> {
    let Some(peer_id) = presented_peer_id else {
        return Ok(anonymous_identity(claim_signer));
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

/// The [`SenderIdentity`] of a request that presented no `ILP-Peer-Id`
/// (`docs/protocol/client-edge-spec.md` §1.2): `http:<signer>` when a
/// plaintext claim named one, the fixed [`ANONYMOUS`] otherwise. This is
/// [`resolve_identity`]'s own anonymous branch, callable directly by a
/// client edge that has already established the request presented no peer
/// id -- so resolving an anonymous sender never has to run, and then
/// discharge, an authentication outcome that cannot happen.
///
/// `claim_signer` carries the same rule it does on [`resolve_identity`]: it
/// is a plaintext `ILP-Payment-Channel-Claim`'s already-parsed,
/// self-declared signer, never a wrapped claim's.
pub fn anonymous_identity(claim_signer: Option<&str>) -> SenderIdentity {
    SenderIdentity::Anonymous(match claim_signer {
        Some(signer) => format!("http:{signer}"),
        None => ANONYMOUS.to_string(),
    })
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
    fn an_anonymous_senders_ephemeral_identity_derives_from_the_already_parsed_claim_signer() {
        let resolved = resolve_identity(None, "", Some("0xabc123"), &[]).unwrap();
        assert_eq!(
            resolved,
            SenderIdentity::Anonymous("http:0xabc123".to_string())
        );
    }

    /// `anonymous_identity` is the same branch `resolve_identity` takes
    /// with no peer id presented, so the two never disagree about what an
    /// anonymous sender is called.
    #[test]
    fn anonymous_identity_is_resolve_identitys_own_no_peer_id_branch() {
        for claim_signer in [None, Some("0xabc123")] {
            assert_eq!(
                anonymous_identity(claim_signer),
                resolve_identity(None, "", claim_signer, &[]).unwrap()
            );
        }
    }

    #[test]
    fn a_solana_signer_is_carried_through_unchanged() {
        let resolved = resolve_identity(None, "", Some("abc123base58"), &[]).unwrap();
        assert_eq!(
            resolved,
            SenderIdentity::Anonymous("http:abc123base58".to_string())
        );
    }

    /// AC: "A request carrying only a wrapped claim gets the fixed
    /// anonymous identity, not one derived from unwrapping." This function
    /// never sees a wrapped claim's contents at all -- only an already-
    /// resolved plaintext `claim_signer` -- so a caller that has only a
    /// wrapped claim to offer (and correctly passes `None` here rather than
    /// unwrapping it first to find a signer) always gets the fixed
    /// identity, by construction.
    #[test]
    fn only_a_wrapped_claim_present_is_equivalent_to_no_claim_at_all() {
        let resolved = resolve_identity(None, "", None, &[]).unwrap();
        assert_eq!(resolved, SenderIdentity::Anonymous(ANONYMOUS.to_string()));
    }
}
