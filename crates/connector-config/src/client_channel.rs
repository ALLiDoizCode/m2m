use serde::Deserialize;

use crate::error::ConfigError;
use crate::settlement::SettlementChain;

/// One `[[client_channels]]` entry as written in the config file, in either
/// chain shape this connector accepts (issue #630): EVM
/// ([`RawEvmClientChannel`]) or Solana ([`RawSolanaClientChannel`]).
/// `#[serde(untagged)]` picks whichever shape matches: the EVM shape
/// requires `channel_id`/`chain_id`/`token_network_address` and forbids
/// `channel_account`, the Solana shape requires `channel_account` and
/// forbids the other three -- mutually exclusive by construction (each
/// variant is `deny_unknown_fields`), the same pattern
/// `crate::settlement::RawSettlementSection` already uses for its own
/// per-chain tables.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum RawClientChannel {
    Evm(RawEvmClientChannel),
    Solana(RawSolanaClientChannel),
}

/// `[[client_channels]]`'s original (and still only shipped) shape (issue
/// #558): a payment channel this node accepts client-edge claims on, and
/// the counterparty whose signature it accepts them from.
/// `deny_unknown_fields` so a mistyped key fails config load loudly instead
/// of being silently dropped -- a dropped `counterparty` here would be a
/// dropped authorization decision.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawEvmClientChannel {
    channel_id: String,
    counterparty: String,
    chain_id: u64,
    token_network_address: String,
}

/// `[[client_channels]]`'s Solana shape (issue #630): the deployed
/// `payment-channel` program's channel PDA (`channel_account`, not an
/// EVM-style `channel_id`) and the base58 Ed25519 public key whose
/// signature this node accepts on a claim for it. No `chain_id` or
/// `token_network_address` -- Solana has neither an EVM-style numeric chain
/// id nor a per-token verifying contract for a declared channel to name.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawSolanaClientChannel {
    channel_account: String,
    counterparty: String,
}

/// A fully validated `[[client_channels]]` EVM entry. Constructed only by
/// [`resolve_client_channels`], so a value that exists has already had its
/// identifier and addresses checked -- downstream code never re-validates
/// any of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvmClientChannelConfig {
    channel_id: String,
    counterparty: [u8; 20],
    chain_id: u64,
    token_network_address: [u8; 20],
}

impl EvmClientChannelConfig {
    /// The channel's on-chain identifier, canonicalized to lowercase
    /// `0x`-prefixed hex however the operator wrote it -- the same value a
    /// claim names the channel by.
    pub fn channel_id(&self) -> &str {
        &self.channel_id
    }

    /// The address whose signature this node accepts on a claim for this
    /// channel. Never the claim's own self-declared signer (issue #558).
    pub fn counterparty(&self) -> [u8; 20] {
        self.counterparty
    }

    /// The chain this channel is deployed on, half of the EIP-712 domain
    /// its balance proofs are signed under (ADR 0024).
    pub fn chain_id(&self) -> u64 {
        self.chain_id
    }

    /// The `TokenNetwork` that verifies this channel's claims on
    /// redemption -- the EIP-712 `verifyingContract`, per-channel because
    /// each token gets its own `TokenNetwork` (issue #566).
    pub fn token_network_address(&self) -> [u8; 20] {
        self.token_network_address
    }
}

/// A fully validated `[[client_channels]]` Solana entry (issue #630).
/// Constructed only by [`resolve_client_channels`] -- both fields have
/// already been checked to be base58-encoded 32-byte Solana accounts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SolanaClientChannelConfig {
    channel_account: String,
    counterparty: String,
}

impl SolanaClientChannelConfig {
    /// The channel's on-chain PDA, base58-encoded -- the same value a
    /// Solana claim names its `channelAccount` by.
    pub fn channel_account(&self) -> &str {
        &self.channel_account
    }

    /// The base58 Ed25519 public key whose signature this node accepts on
    /// a claim for this channel. Never the claim's own self-declared
    /// `signerPublicKey` (issue #558's rule, Solana-flavored).
    pub fn counterparty(&self) -> &str {
        &self.counterparty
    }
}

/// One `[[client_channels]]` entry, typed by chain (issue #630) -- an EVM
/// `channelId` and a Solana `channelAccount` name genuinely different kinds
/// of on-chain identifier, so a single shared shape would either force one
/// to fake fields it does not have or erase which chain a value came from.
/// The same reason [`crate::SettlementConfig`] is an enum rather than one
/// struct with optional fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientChannelConfig {
    Evm(EvmClientChannelConfig),
    Solana(SolanaClientChannelConfig),
}

impl ClientChannelConfig {
    /// The chain this declared channel lives on.
    pub fn chain(&self) -> SettlementChain {
        match self {
            ClientChannelConfig::Evm(_) => SettlementChain::Evm,
            ClientChannelConfig::Solana(_) => SettlementChain::Solana,
        }
    }
}

/// Parse a 20-byte EVM address written as 40 hex characters, an optional
/// `0x`/`0X` prefix accepted -- same rule as `crate::settlement`'s own
/// addresses, since operators write both the same way.
pub(crate) fn parse_evm_address(value: &str) -> Option<[u8; 20]> {
    parse_hex_bytes::<20>(value)
}

pub(crate) fn parse_hex_bytes<const N: usize>(value: &str) -> Option<[u8; N]> {
    let hex = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .unwrap_or(value);
    if hex.len() != N * 2 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

pub(crate) fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("0x");
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Whether `value` is base58 encoding exactly 32 bytes -- a Solana account
/// or Ed25519 public key's own wire shape. Only checked, never decoded into
/// bytes and re-encoded: `record_solana`
/// (`connector_client_edge::ClientChannelRegistry`) does the actual
/// base58-to-bytes decoding at the point it is used, so this config crate
/// stores exactly the string the operator wrote (already validated),
/// matching [`EvmClientChannelConfig::channel_id`]'s own "canonicalized
/// string, not raw bytes" shape.
pub(crate) fn is_base58_32_bytes(value: &str) -> bool {
    matches!(bs58::decode(value).into_vec(), Ok(bytes) if bytes.len() == 32)
}

fn resolve_evm_client_channel(
    raw: RawEvmClientChannel,
) -> Result<EvmClientChannelConfig, ConfigError> {
    let channel_id = parse_hex_bytes::<32>(&raw.channel_id).ok_or_else(|| {
        ConfigError::ClientChannelInvalidId {
            value: raw.channel_id.clone(),
        }
    })?;
    let counterparty = parse_evm_address(&raw.counterparty).ok_or_else(|| {
        ConfigError::ClientChannelInvalidAddress {
            field: "counterparty",
            value: raw.counterparty.clone(),
        }
    })?;
    let token_network_address = parse_evm_address(&raw.token_network_address).ok_or_else(|| {
        ConfigError::ClientChannelInvalidAddress {
            field: "token_network_address",
            value: raw.token_network_address.clone(),
        }
    })?;
    Ok(EvmClientChannelConfig {
        channel_id: to_hex(&channel_id),
        counterparty,
        chain_id: raw.chain_id,
        token_network_address,
    })
}

fn resolve_solana_client_channel(
    raw: RawSolanaClientChannel,
) -> Result<SolanaClientChannelConfig, ConfigError> {
    if !is_base58_32_bytes(&raw.channel_account) {
        return Err(ConfigError::ClientChannelInvalidSolanaAccount {
            field: "channel_account",
            value: raw.channel_account,
        });
    }
    if !is_base58_32_bytes(&raw.counterparty) {
        return Err(ConfigError::ClientChannelInvalidSolanaAccount {
            field: "counterparty",
            value: raw.counterparty,
        });
    }
    Ok(SolanaClientChannelConfig {
        channel_account: raw.channel_account,
        counterparty: raw.counterparty,
    })
}

/// Validate every `[[client_channels]]` entry. An empty list is valid and
/// means this node has a record of no channel -- every claim presented to
/// its client edge is refused as unknown (issue #558), which is the
/// intended failure mode rather than an open door.
pub(crate) fn resolve_client_channels(
    raw: Vec<RawClientChannel>,
) -> Result<Vec<ClientChannelConfig>, ConfigError> {
    let mut channels: Vec<ClientChannelConfig> = Vec::with_capacity(raw.len());
    for entry in raw {
        let channel = match entry {
            RawClientChannel::Evm(evm) => {
                ClientChannelConfig::Evm(resolve_evm_client_channel(evm)?)
            }
            RawClientChannel::Solana(solana) => {
                ClientChannelConfig::Solana(resolve_solana_client_channel(solana)?)
            }
        };
        // Two entries for one channel would mean two answers to "whose
        // signature do I accept here", with the last one silently winning.
        // EVM and Solana are separate namespaces (issue #630, matching
        // `connector_client_edge::ClientChannelRegistry`'s own split), so
        // duplication is checked within a chain, never across.
        let duplicate = match &channel {
            ClientChannelConfig::Evm(evm) => channels
                .iter()
                .any(|existing| {
                    matches!(existing, ClientChannelConfig::Evm(e) if e.channel_id == evm.channel_id)
                })
                .then(|| evm.channel_id.clone()),
            ClientChannelConfig::Solana(solana) => channels
                .iter()
                .any(|existing| {
                    matches!(existing, ClientChannelConfig::Solana(s) if s.channel_account == solana.channel_account)
                })
                .then(|| solana.channel_account.clone()),
        };
        if let Some(value) = duplicate {
            return Err(ConfigError::ClientChannelDuplicate { value });
        }
        channels.push(channel);
    }
    Ok(channels)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw_evm(channel_id: &str) -> RawClientChannel {
        RawClientChannel::Evm(RawEvmClientChannel {
            channel_id: channel_id.to_string(),
            counterparty: "0x00000000000000000000000000000000000000aa".to_string(),
            chain_id: 8453,
            token_network_address: "0x00000000000000000000000000000000000000bb".to_string(),
        })
    }

    fn raw_solana(channel_account: &str, counterparty: &str) -> RawClientChannel {
        RawClientChannel::Solana(RawSolanaClientChannel {
            channel_account: channel_account.to_string(),
            counterparty: counterparty.to_string(),
        })
    }

    /// A real base58-encoded 32-byte value -- `[1u8; 32]` -- used wherever a
    /// test needs a well-formed Solana account without caring which one.
    const SOME_SOLANA_ACCOUNT: &str = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";

    #[test]
    fn an_evm_channel_id_is_canonicalized_however_it_was_written() {
        let channels = resolve_client_channels(vec![raw_evm(&"AB".repeat(32))]).expect("valid");
        let ClientChannelConfig::Evm(evm) = &channels[0] else {
            panic!("expected an EVM channel");
        };
        assert_eq!(evm.channel_id(), format!("0x{}", "ab".repeat(32)));
        assert_eq!(evm.counterparty()[19], 0xaa);
        assert_eq!(evm.token_network_address()[19], 0xbb);
        assert_eq!(evm.chain_id(), 8453);
        assert_eq!(channels[0].chain(), SettlementChain::Evm);
    }

    #[test]
    fn an_evm_id_that_is_not_a_32_byte_channel_is_refused() {
        let error = resolve_client_channels(vec![raw_evm("0xdeadbeef")]).unwrap_err();
        assert!(matches!(error, ConfigError::ClientChannelInvalidId { .. }));
    }

    #[test]
    fn an_evm_counterparty_that_is_not_an_evm_address_is_refused() {
        let RawClientChannel::Evm(mut entry) = raw_evm(&"ab".repeat(32)) else {
            unreachable!()
        };
        entry.counterparty = "not-an-address".to_string();
        let error = resolve_client_channels(vec![RawClientChannel::Evm(entry)]).unwrap_err();
        assert!(matches!(
            error,
            ConfigError::ClientChannelInvalidAddress {
                field: "counterparty",
                ..
            }
        ));
    }

    #[test]
    fn the_same_evm_channel_configured_twice_is_refused_never_last_one_wins() {
        let error =
            resolve_client_channels(vec![raw_evm(&"ab".repeat(32)), raw_evm(&"AB".repeat(32))])
                .unwrap_err();
        assert!(matches!(error, ConfigError::ClientChannelDuplicate { .. }));
    }

    #[test]
    fn no_client_channels_is_valid_and_records_nothing() {
        assert!(resolve_client_channels(vec![]).expect("valid").is_empty());
    }

    /// Issue #630's AC: a `[[client_channels]]` entry can declare a Solana
    /// channel -- `channel_account`/`counterparty` rather than `channel_id`/
    /// `chain_id`/`token_network_address` -- and parses into a distinctly
    /// typed [`ClientChannelConfig::Solana`].
    #[test]
    fn a_solana_client_channel_is_declared_and_typed_distinctly_from_evm() {
        let counterparty = "8pM1DN3RiT8vbom5u1sNryaNT1nyL8CTTW3b5PwWXRBH";
        let channels = resolve_client_channels(vec![raw_solana(SOME_SOLANA_ACCOUNT, counterparty)])
            .expect("valid");
        let ClientChannelConfig::Solana(solana) = &channels[0] else {
            panic!("expected a Solana channel");
        };
        assert_eq!(solana.channel_account(), SOME_SOLANA_ACCOUNT);
        assert_eq!(solana.counterparty(), counterparty);
        assert_eq!(channels[0].chain(), SettlementChain::Solana);
    }

    #[test]
    fn a_solana_channel_account_that_is_not_valid_base58_32_bytes_is_refused() {
        let error = resolve_client_channels(vec![raw_solana("not-base58!!!", SOME_SOLANA_ACCOUNT)])
            .unwrap_err();
        assert!(matches!(
            error,
            ConfigError::ClientChannelInvalidSolanaAccount {
                field: "channel_account",
                ..
            }
        ));
    }

    #[test]
    fn a_solana_counterparty_that_decodes_to_the_wrong_length_is_refused() {
        // Valid base58, but not 32 bytes once decoded.
        let error =
            resolve_client_channels(vec![raw_solana(SOME_SOLANA_ACCOUNT, "abc")]).unwrap_err();
        assert!(matches!(
            error,
            ConfigError::ClientChannelInvalidSolanaAccount {
                field: "counterparty",
                ..
            }
        ));
    }

    #[test]
    fn the_same_solana_channel_configured_twice_is_refused() {
        let error = resolve_client_channels(vec![
            raw_solana(SOME_SOLANA_ACCOUNT, SOME_SOLANA_ACCOUNT),
            raw_solana(SOME_SOLANA_ACCOUNT, SOME_SOLANA_ACCOUNT),
        ])
        .unwrap_err();
        assert!(matches!(error, ConfigError::ClientChannelDuplicate { .. }));
    }

    /// EVM and Solana channels are separate namespaces (issue #630): an EVM
    /// `channel_id` and a Solana `channel_account` can coexist, and a
    /// duplicate check on one chain must never trip on the other's entry.
    #[test]
    fn evm_and_solana_client_channels_coexist_without_colliding() {
        let channels = resolve_client_channels(vec![
            raw_evm(&"ab".repeat(32)),
            raw_solana(SOME_SOLANA_ACCOUNT, SOME_SOLANA_ACCOUNT),
        ])
        .expect("valid: distinct chains never collide");
        assert_eq!(channels.len(), 2);
    }

    /// `#[serde(untagged)]` really does dispatch on the config file's own
    /// shape: this is the TOML-level proof, not just the constructor-level
    /// one above.
    #[test]
    fn toml_deserializes_each_shape_into_its_own_raw_variant() {
        let raw: RawClientChannel = toml::from_str(&format!(
            r#"
channel_id = "0x{}"
counterparty = "0x00000000000000000000000000000000000000aa"
chain_id = 8453
token_network_address = "0x00000000000000000000000000000000000000bb"
"#,
            "ab".repeat(32)
        ))
        .expect("valid EVM TOML");
        assert!(matches!(raw, RawClientChannel::Evm(_)));

        let raw: RawClientChannel = toml::from_str(&format!(
            r#"
channel_account = "{SOME_SOLANA_ACCOUNT}"
counterparty = "{SOME_SOLANA_ACCOUNT}"
"#
        ))
        .expect("valid Solana TOML");
        assert!(matches!(raw, RawClientChannel::Solana(_)));
    }
}
