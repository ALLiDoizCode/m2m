use std::path::PathBuf;

use serde::Deserialize;
use url::Url;

use crate::error::ConfigError;
use crate::secret::SecretLocation;

/// The `[settlement]` section as written in the config file. Its presence
/// enables a settlement backend (issue #542); its absence means channel
/// operations keep degrading to `ChannelOperationError::NoSettlementBackend`,
/// exactly as before this section existed. `deny_unknown_fields` so a
/// mistyped key (`rpc__url`, `contractaddress`, ...) fails config load
/// loudly instead of being parsed, silently dropped, and honoured as if it
/// had never been written.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawSettlementConfig {
    chain: String,
    rpc_url: String,
    contract_address: String,
    token_address: String,
    decimals: u8,
    key: RawSettlementKeyConfig,
}

/// The `[settlement.key]` sub-section: where the key material this
/// backend signs settlement transactions with lives. Same File-or-KMS
/// shape as the top-level `[signer]` section (`crate::secret`), kept as
/// its own type rather than reused directly because the two locations are
/// independent config-file positions with their own `deny_unknown_fields`
/// boundary.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawSettlementKeyConfig {
    #[serde(default)]
    key_file: Option<PathBuf>,
    #[serde(default)]
    kms_key_id: Option<String>,
}

/// The chains a [`SettlementConfig`] can name. Only [`SettlementChain::Evm`]
/// is recognized today (issue #542) -- a `chain` value naming anything
/// else, including "solana" (a real backend `connector-settlement-solana`
/// already implements, just not yet wired into `connector-cli`), is refused
/// at load time via [`ConfigError::SettlementUnknownChain`] rather than
/// silently accepted and later failing to construct.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettlementChain {
    Evm,
}

/// A fully validated `[settlement]` section: which chain, where its RPC
/// endpoint is, which already-deployed `TokenNetworkRegistry` and ERC-20
/// asset it settles through, and where the signing key material lives.
/// Constructed only by [`resolve_settlement`], so a value that exists has
/// already had every field checked -- downstream code never re-validates
/// any of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettlementConfig {
    chain: SettlementChain,
    rpc_url: String,
    contract_address: [u8; 20],
    token_address: [u8; 20],
    decimals: u8,
    key: SecretLocation,
}

impl SettlementConfig {
    /// The chain this settlement backend talks to.
    pub fn chain(&self) -> SettlementChain {
        self.chain
    }

    /// The RPC endpoint this backend connects through.
    pub fn rpc_url(&self) -> &str {
        &self.rpc_url
    }

    /// The already-deployed `TokenNetworkRegistry` this backend resolves
    /// its actual `TokenNetwork` through, keyed by [`token_address`](Self::token_address)
    /// (issue #576) -- not a channel contract itself.
    pub fn contract_address(&self) -> [u8; 20] {
        self.contract_address
    }

    /// The ERC-20 asset every channel this backend opens settles in, and
    /// the input `TokenNetworkRegistry.getTokenNetwork` resolves
    /// [`contract_address`](Self::contract_address) against to find the
    /// actual `TokenNetwork` (issue #576 closes out this field's half of
    /// issue #564 -- construction now reads it rather than validating and
    /// discarding it).
    pub fn token_address(&self) -> [u8; 20] {
        self.token_address
    }

    /// The settlement asset's decimal precision (6 for the USDC this
    /// connector settles -- issue #542's decision comment).
    ///
    /// Nothing scales by this value, and nothing should: every amount on
    /// this connector's value path -- route prices, claim amounts, channel
    /// deposits -- is already in the settlement token's own base units, and
    /// `docs/usdc-cross-chain-settlement.md`'s "6 decimals everywhere"
    /// makes those units uniform across every chain in the fleet, so there
    /// is no cross-chain normalization for a scale factor to feed.
    ///
    /// It is honoured as a *check* instead (issue #564):
    /// `EvmSettlementBackend::connect` reads the deployed token's own
    /// `decimals()` and refuses to start when it disagrees with this value,
    /// naming both. That is the startup assertion
    /// `docs/usdc-cross-chain-settlement.md` calls for, and it is what
    /// keeps a stale `decimals = 18` from loading as if it were honoured
    /// (ADR 0009).
    pub fn decimals(&self) -> u8 {
        self.decimals
    }

    /// Where this backend's signing key material lives.
    pub fn key(&self) -> &SecretLocation {
        &self.key
    }
}

/// Parse a 20-byte EVM address written as 40 hex characters, an optional
/// `0x`/`0X` prefix accepted since that is how every address in this
/// workspace's own docs, infra and decision comments is already written
/// (e.g. `'0x49beE1Bca5d15Fb0963117923403F9498119a9Ce'`).
fn parse_evm_address(value: &str) -> Option<[u8; 20]> {
    let hex = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .unwrap_or(value);
    if hex.len() != 40 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 20];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn resolve_settlement_key(raw: RawSettlementKeyConfig) -> Result<SecretLocation, ConfigError> {
    match (raw.key_file, raw.kms_key_id) {
        (Some(path), None) => {
            if !path.is_file() {
                return Err(ConfigError::SettlementKeyFileNotFound(path));
            }
            Ok(SecretLocation::File(path))
        }
        (None, Some(key_id)) => {
            if key_id.trim().is_empty() {
                return Err(ConfigError::SettlementKmsIdEmpty);
            }
            Ok(SecretLocation::Kms { key_id })
        }
        (None, None) => Err(ConfigError::SettlementKeyLocationAmbiguous {
            reason: "neither 'key_file' nor 'kms_key_id' is set",
        }),
        (Some(_), Some(_)) => Err(ConfigError::SettlementKeyLocationAmbiguous {
            reason: "both 'key_file' and 'kms_key_id' are set",
        }),
    }
}

/// Validate an optional `[settlement]` section. Presence configures a real
/// settlement backend (issue #542); absence means channel operations keep
/// degrading exactly as they did before this section existed --
/// `ChannelOperationError::NoSettlementBackend`, the same "not started at
/// all" shape an absent `[operator]` section already has.
pub(crate) fn resolve_settlement(
    raw: Option<RawSettlementConfig>,
) -> Result<Option<SettlementConfig>, ConfigError> {
    let Some(raw) = raw else {
        return Ok(None);
    };

    let chain = match raw.chain.as_str() {
        "evm" => SettlementChain::Evm,
        other => {
            return Err(ConfigError::SettlementUnknownChain {
                value: other.to_string(),
            })
        }
    };

    if raw.rpc_url.trim().is_empty() {
        return Err(ConfigError::SettlementMissingRpcUrl);
    }
    let url = Url::parse(&raw.rpc_url).map_err(|source| ConfigError::SettlementInvalidRpcUrl {
        value: raw.rpc_url.clone(),
        source,
    })?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(ConfigError::SettlementUnsupportedRpcScheme {
            value: raw.rpc_url.clone(),
        });
    }

    let contract_address = parse_evm_address(&raw.contract_address).ok_or_else(|| {
        ConfigError::SettlementInvalidContractAddress {
            value: raw.contract_address.clone(),
        }
    })?;
    let token_address = parse_evm_address(&raw.token_address).ok_or_else(|| {
        ConfigError::SettlementInvalidTokenAddress {
            value: raw.token_address.clone(),
        }
    })?;

    if raw.decimals == 0 {
        return Err(ConfigError::SettlementZeroDecimals);
    }

    let key = resolve_settlement_key(raw.key)?;

    Ok(Some(SettlementConfig {
        chain,
        rpc_url: raw.rpc_url,
        contract_address,
        token_address,
        decimals: raw.decimals,
        key,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(
        chain: &str,
        rpc_url: &str,
        contract_address: &str,
        token_address: &str,
        decimals: u8,
        key_file: Option<PathBuf>,
    ) -> RawSettlementConfig {
        RawSettlementConfig {
            chain: chain.to_string(),
            rpc_url: rpc_url.to_string(),
            contract_address: contract_address.to_string(),
            token_address: token_address.to_string(),
            decimals,
            key: RawSettlementKeyConfig {
                key_file,
                kms_key_id: None,
            },
        }
    }

    fn temp_key_file() -> tempfile::NamedTempFile {
        tempfile::NamedTempFile::new().expect("temp key file")
    }

    const CONTRACT: &str = "0x1234567890123456789012345678901234567890";
    const TOKEN: &str = "0x49beE1Bca5d15Fb0963117923403F9498119a9Ce";

    #[test]
    fn absent_settlement_section_resolves_to_none() {
        let resolved = resolve_settlement(None).expect("resolve");
        assert_eq!(resolved, None);
    }

    #[test]
    fn a_fully_configured_evm_section_resolves() {
        let key_file = temp_key_file();
        let resolved = resolve_settlement(Some(raw(
            "evm",
            "http://127.0.0.1:8545",
            CONTRACT,
            TOKEN,
            6,
            Some(key_file.path().to_path_buf()),
        )))
        .expect("resolve")
        .expect("some");

        assert_eq!(resolved.chain(), SettlementChain::Evm);
        assert_eq!(resolved.rpc_url(), "http://127.0.0.1:8545");
        assert_eq!(
            resolved.contract_address(),
            parse_evm_address(CONTRACT).unwrap()
        );
        assert_eq!(resolved.token_address(), parse_evm_address(TOKEN).unwrap());
        assert_eq!(resolved.decimals(), 6);
        assert_eq!(
            resolved.key(),
            &SecretLocation::File(key_file.path().to_path_buf())
        );
    }

    #[test]
    fn a_contract_address_without_a_0x_prefix_still_parses() {
        let key_file = temp_key_file();
        let resolved = resolve_settlement(Some(raw(
            "evm",
            "http://127.0.0.1:8545",
            "1234567890123456789012345678901234567890",
            TOKEN,
            6,
            Some(key_file.path().to_path_buf()),
        )))
        .expect("resolve")
        .expect("some");
        assert_eq!(
            resolved.contract_address(),
            parse_evm_address(CONTRACT).unwrap()
        );
    }

    #[test]
    fn rejects_an_unknown_chain() {
        let key_file = temp_key_file();
        let result = resolve_settlement(Some(raw(
            "solana",
            "http://127.0.0.1:8545",
            CONTRACT,
            TOKEN,
            6,
            Some(key_file.path().to_path_buf()),
        )));
        assert!(matches!(
            result,
            Err(ConfigError::SettlementUnknownChain { .. })
        ));
    }

    #[test]
    fn rejects_an_empty_rpc_url() {
        let key_file = temp_key_file();
        let result = resolve_settlement(Some(raw(
            "evm",
            "",
            CONTRACT,
            TOKEN,
            6,
            Some(key_file.path().to_path_buf()),
        )));
        assert!(matches!(result, Err(ConfigError::SettlementMissingRpcUrl)));
    }

    #[test]
    fn rejects_a_non_http_rpc_scheme() {
        let key_file = temp_key_file();
        let result = resolve_settlement(Some(raw(
            "evm",
            "ws://127.0.0.1:8545",
            CONTRACT,
            TOKEN,
            6,
            Some(key_file.path().to_path_buf()),
        )));
        assert!(matches!(
            result,
            Err(ConfigError::SettlementUnsupportedRpcScheme { .. })
        ));
    }

    #[test]
    fn rejects_a_malformed_rpc_url() {
        let key_file = temp_key_file();
        let result = resolve_settlement(Some(raw(
            "evm",
            "not a url",
            CONTRACT,
            TOKEN,
            6,
            Some(key_file.path().to_path_buf()),
        )));
        assert!(matches!(
            result,
            Err(ConfigError::SettlementInvalidRpcUrl { .. })
        ));
    }

    #[test]
    fn rejects_an_invalid_contract_address() {
        let key_file = temp_key_file();
        let result = resolve_settlement(Some(raw(
            "evm",
            "http://127.0.0.1:8545",
            "not-an-address",
            TOKEN,
            6,
            Some(key_file.path().to_path_buf()),
        )));
        assert!(matches!(
            result,
            Err(ConfigError::SettlementInvalidContractAddress { .. })
        ));
    }

    #[test]
    fn rejects_an_invalid_token_address() {
        let key_file = temp_key_file();
        let result = resolve_settlement(Some(raw(
            "evm",
            "http://127.0.0.1:8545",
            CONTRACT,
            "not-an-address",
            6,
            Some(key_file.path().to_path_buf()),
        )));
        assert!(matches!(
            result,
            Err(ConfigError::SettlementInvalidTokenAddress { .. })
        ));
    }

    #[test]
    fn rejects_zero_decimals() {
        let key_file = temp_key_file();
        let result = resolve_settlement(Some(raw(
            "evm",
            "http://127.0.0.1:8545",
            CONTRACT,
            TOKEN,
            0,
            Some(key_file.path().to_path_buf()),
        )));
        assert!(matches!(result, Err(ConfigError::SettlementZeroDecimals)));
    }

    #[test]
    fn rejects_a_settlement_key_naming_neither_location() {
        let result = resolve_settlement(Some(raw(
            "evm",
            "http://127.0.0.1:8545",
            CONTRACT,
            TOKEN,
            6,
            None,
        )));
        assert!(matches!(
            result,
            Err(ConfigError::SettlementKeyLocationAmbiguous { .. })
        ));
    }

    #[test]
    fn rejects_a_settlement_key_file_that_does_not_exist() {
        let result = resolve_settlement(Some(raw(
            "evm",
            "http://127.0.0.1:8545",
            CONTRACT,
            TOKEN,
            6,
            Some(PathBuf::from("/nonexistent/does-not-exist.key")),
        )));
        assert!(matches!(
            result,
            Err(ConfigError::SettlementKeyFileNotFound(_))
        ));
    }

    #[test]
    fn an_unknown_key_in_the_settlement_section_is_rejected_at_parse_time() {
        let key_file = temp_key_file();
        let text = format!(
            r#"
chain = "evm"
rpc_url = "http://127.0.0.1:8545"
contract_address = "{CONTRACT}"
token_address = "{TOKEN}"
decimals = 6
made_up_field = "oops"

[key]
key_file = "{}"
"#,
            key_file.path().display()
        );
        let result: Result<RawSettlementConfig, _> = toml::from_str(&text);
        assert!(result.is_err());
    }
}
