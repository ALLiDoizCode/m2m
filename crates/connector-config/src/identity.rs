use std::collections::HashSet;

use serde::Deserialize;

use crate::error::ConfigError;

/// A `[[client_identities]]` entry as written in the config file: a
/// client-edge identity this node authenticates over HTTP
/// (`docs/protocol/client-edge-spec.md` §1.2), distinct from `[[peers]]`
/// (a peering relation this node *dials*, addressed by `SocketAddr`).
/// A client identity has no network address of its own -- it is
/// authenticated by `id` + `secret` alone, since the party presenting it
/// (a registered buyer over `POST /ilp`) is never something this node
/// connects out to.
#[derive(Debug, Deserialize)]
pub(crate) struct RawClientIdentity {
    id: String,
    #[serde(default)]
    secret: String,
}

/// A fully validated `[[client_identities]]` entry: a non-empty id, unique
/// among every other configured client identity, plus the secret a request
/// must present via `Authorization: Bearer <secret>` to authenticate as it.
/// An empty `secret` means this identity is permissionless -- a request
/// presenting `id` with no `Authorization` header authenticates.
/// Constructed only by [`resolve_client_identities`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientIdentityConfig {
    id: String,
    secret: String,
}

impl ClientIdentityConfig {
    /// This identity's id -- what a request's `ILP-Peer-Id` header names.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The secret a request must present via `Authorization: Bearer
    /// <secret>` to authenticate as this identity. Empty means
    /// permissionless.
    pub fn secret(&self) -> &str {
        &self.secret
    }
}

pub(crate) fn resolve_client_identities(
    raw: Vec<RawClientIdentity>,
) -> Result<Vec<ClientIdentityConfig>, ConfigError> {
    let mut seen = HashSet::with_capacity(raw.len());
    let mut identities = Vec::with_capacity(raw.len());

    for identity in raw {
        if identity.id.trim().is_empty() {
            return Err(ConfigError::ClientIdentityIdEmpty);
        }
        if !seen.insert(identity.id.clone()) {
            return Err(ConfigError::DuplicateClientIdentityId { id: identity.id });
        }
        identities.push(ClientIdentityConfig {
            id: identity.id,
            secret: identity.secret,
        });
    }

    Ok(identities)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(id: &str, secret: &str) -> RawClientIdentity {
        RawClientIdentity {
            id: id.to_string(),
            secret: secret.to_string(),
        }
    }

    #[test]
    fn resolves_valid_client_identities() {
        let identities = resolve_client_identities(vec![raw("peer-a", "s3cr3t")]).expect("resolve");
        assert_eq!(identities.len(), 1);
        assert_eq!(identities[0].id(), "peer-a");
        assert_eq!(identities[0].secret(), "s3cr3t");
    }

    #[test]
    fn defaults_a_missing_secret_to_empty() {
        let identities = resolve_client_identities(vec![raw("peer-a", "")]).expect("resolve");
        assert_eq!(identities[0].secret(), "");
    }

    #[test]
    fn rejects_an_empty_id() {
        let result = resolve_client_identities(vec![raw("", "s3cr3t")]);
        assert!(matches!(result, Err(ConfigError::ClientIdentityIdEmpty)));
    }

    #[test]
    fn rejects_a_duplicate_id() {
        let result = resolve_client_identities(vec![raw("peer-a", "one"), raw("peer-a", "two")]);
        assert!(matches!(
            result,
            Err(ConfigError::DuplicateClientIdentityId { id }) if id == "peer-a"
        ));
    }
}
