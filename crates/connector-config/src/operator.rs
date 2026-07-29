use serde::Deserialize;

use crate::error::ConfigError;

/// The `[operator]` section as written in the config file. Its presence
/// enables the operator surface (ADR 0008); its absence means the surface
/// is not started at all, and none of the fields below are read.
///
/// `deny_unknown_fields` (issue #556): a mistyped `bearer_tokn` or
/// `write_key` would otherwise be dropped and the section resolved as
/// "present but unauthenticated", which `resolve_operator` then reports as
/// a missing token rather than as the typo it is. The surface's own
/// fail-closed guarantee (ADR 0008) is only as good as the parse beneath it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawOperatorConfig {
    #[serde(default)]
    bearer_token: String,
    #[serde(default)]
    write_keys: Vec<String>,
}

/// The operator surface's authentication, fully validated (ADR 0008): a
/// bearer token that gates every read, and an allowlist of ed25519 public
/// keys that gate every write via an RFC 9421 signature. Constructed only
/// by [`resolve_operator`], so a value that exists is never
/// unauthenticated -- there is no way to enable the surface without both.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorConfig {
    bearer_token: String,
    write_keys: Vec<[u8; 32]>,
}

impl OperatorConfig {
    /// The bearer token every read on the operator surface must present.
    pub fn bearer_token(&self) -> &str {
        &self.bearer_token
    }

    /// The ed25519 public keys allowed to sign a write. Removing a key
    /// from this list and restarting is how an operator's write authority
    /// is revoked (ADR 0008) -- config is immutable for the process
    /// lifetime (ADR 0009), so revocation is never a live operation.
    pub fn write_keys(&self) -> &[[u8; 32]] {
        &self.write_keys
    }
}

fn parse_write_key(value: &str) -> Result<[u8; 32], ConfigError> {
    hex_decode_32(value).ok_or_else(|| ConfigError::OperatorInvalidWriteKey {
        value: value.to_string(),
    })
}

fn hex_decode_32(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Validate an optional `[operator]` section. Presence enables the
/// operator surface; if enabled, a non-empty bearer token and at least
/// one write key are both required. A surface that is enabled but would
/// have no authentication -- an empty token, or no allowlisted write key
/// -- must refuse to start rather than run open (ADR 0009's "refuse to
/// start" contract, applied to ADR 0008's auth requirement).
pub(crate) fn resolve_operator(
    raw: Option<RawOperatorConfig>,
) -> Result<Option<OperatorConfig>, ConfigError> {
    let Some(raw) = raw else {
        return Ok(None);
    };

    if raw.bearer_token.trim().is_empty() {
        return Err(ConfigError::OperatorMissingBearerToken);
    }
    if raw.write_keys.is_empty() {
        return Err(ConfigError::OperatorNoWriteKeys);
    }

    let write_keys = raw
        .write_keys
        .iter()
        .map(|key| parse_write_key(key))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Some(OperatorConfig {
        bearer_token: raw.bearer_token,
        write_keys,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(bearer_token: &str, write_keys: &[&str]) -> RawOperatorConfig {
        RawOperatorConfig {
            bearer_token: bearer_token.to_string(),
            write_keys: write_keys.iter().map(|k| k.to_string()).collect(),
        }
    }

    #[test]
    fn absent_operator_section_resolves_to_none() {
        let resolved = resolve_operator(None).expect("resolve");
        assert_eq!(resolved, None);
    }

    #[test]
    fn a_fully_configured_section_resolves() {
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let resolved = resolve_operator(Some(raw("secret-token", &[key])))
            .expect("resolve")
            .expect("some");

        assert_eq!(resolved.bearer_token(), "secret-token");
        assert_eq!(resolved.write_keys().len(), 1);
        assert_eq!(resolved.write_keys()[0][0], 0x01);
    }

    #[test]
    fn rejects_an_empty_bearer_token() {
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let result = resolve_operator(Some(raw("", &[key])));
        assert!(matches!(
            result,
            Err(ConfigError::OperatorMissingBearerToken)
        ));
    }

    #[test]
    fn rejects_a_blank_bearer_token() {
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let result = resolve_operator(Some(raw("   ", &[key])));
        assert!(matches!(
            result,
            Err(ConfigError::OperatorMissingBearerToken)
        ));
    }

    #[test]
    fn rejects_no_write_keys() {
        let result = resolve_operator(Some(raw("secret-token", &[])));
        assert!(matches!(result, Err(ConfigError::OperatorNoWriteKeys)));
    }

    #[test]
    fn rejects_a_write_key_of_the_wrong_length() {
        let result = resolve_operator(Some(raw("secret-token", &["abcd"])));
        assert!(matches!(
            result,
            Err(ConfigError::OperatorInvalidWriteKey { .. })
        ));
    }

    #[test]
    fn rejects_a_non_hex_write_key() {
        let non_hex = "zz23456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let result = resolve_operator(Some(raw("secret-token", &[non_hex])));
        assert!(matches!(
            result,
            Err(ConfigError::OperatorInvalidWriteKey { .. })
        ));
    }
}
