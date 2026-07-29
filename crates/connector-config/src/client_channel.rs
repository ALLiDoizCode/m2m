use serde::Deserialize;

use crate::error::ConfigError;

/// One `[[client_channels]]` entry as written in the config file: a payment
/// channel this node accepts client-edge claims on, and the counterparty
/// whose signature it accepts them from (issue #558). `deny_unknown_fields`
/// so a mistyped key fails config load loudly instead of being silently
/// dropped -- a dropped `counterparty` here would be a dropped
/// authorization decision.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawClientChannel {
    channel_id: String,
    counterparty: String,
    chain_id: u64,
    token_network_address: String,
}

/// A fully validated `[[client_channels]]` entry. Constructed only by
/// [`resolve_client_channels`], so a value that exists has already had its
/// identifier and addresses checked -- downstream code never re-validates
/// any of them.
///
/// EVM-only, matching `crate::SettlementChain`'s own single variant: the
/// Rust connector settles no other chain today, and a channel it cannot
/// settle is not one it should be accepting claims against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientChannelConfig {
    channel_id: String,
    counterparty: [u8; 20],
    chain_id: u64,
    token_network_address: [u8; 20],
}

impl ClientChannelConfig {
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

/// Parse a 20-byte EVM address written as 40 hex characters, an optional
/// `0x`/`0X` prefix accepted -- same rule as `crate::settlement`'s own
/// addresses, since operators write both the same way.
fn parse_evm_address(value: &str) -> Option<[u8; 20]> {
    parse_hex_bytes::<20>(value)
}

fn parse_hex_bytes<const N: usize>(value: &str) -> Option<[u8; N]> {
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

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("0x");
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
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
        let channel_id = parse_hex_bytes::<32>(&entry.channel_id).ok_or_else(|| {
            ConfigError::ClientChannelInvalidId {
                value: entry.channel_id.clone(),
            }
        })?;
        let counterparty = parse_evm_address(&entry.counterparty).ok_or_else(|| {
            ConfigError::ClientChannelInvalidAddress {
                field: "counterparty",
                value: entry.counterparty.clone(),
            }
        })?;
        let token_network_address =
            parse_evm_address(&entry.token_network_address).ok_or_else(|| {
                ConfigError::ClientChannelInvalidAddress {
                    field: "token_network_address",
                    value: entry.token_network_address.clone(),
                }
            })?;
        let channel_id = to_hex(&channel_id);
        // Two entries for one channel would mean two answers to "whose
        // signature do I accept here", with the last one silently winning.
        if channels.iter().any(|c| c.channel_id == channel_id) {
            return Err(ConfigError::ClientChannelDuplicate { value: channel_id });
        }
        channels.push(ClientChannelConfig {
            channel_id,
            counterparty,
            chain_id: entry.chain_id,
            token_network_address,
        });
    }
    Ok(channels)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(channel_id: &str) -> RawClientChannel {
        RawClientChannel {
            channel_id: channel_id.to_string(),
            counterparty: "0x00000000000000000000000000000000000000aa".to_string(),
            chain_id: 8453,
            token_network_address: "0x00000000000000000000000000000000000000bb".to_string(),
        }
    }

    #[test]
    fn a_channel_id_is_canonicalized_however_it_was_written() {
        let channels = resolve_client_channels(vec![raw(&"AB".repeat(32))]).expect("valid");
        assert_eq!(channels[0].channel_id(), format!("0x{}", "ab".repeat(32)));
        assert_eq!(channels[0].counterparty()[19], 0xaa);
        assert_eq!(channels[0].token_network_address()[19], 0xbb);
        assert_eq!(channels[0].chain_id(), 8453);
    }

    #[test]
    fn an_id_that_is_not_a_32_byte_channel_is_refused() {
        let error = resolve_client_channels(vec![raw("0xdeadbeef")]).unwrap_err();
        assert!(matches!(error, ConfigError::ClientChannelInvalidId { .. }));
    }

    #[test]
    fn a_counterparty_that_is_not_an_evm_address_is_refused() {
        let mut entry = raw(&"ab".repeat(32));
        entry.counterparty = "not-an-address".to_string();
        let error = resolve_client_channels(vec![entry]).unwrap_err();
        assert!(matches!(
            error,
            ConfigError::ClientChannelInvalidAddress {
                field: "counterparty",
                ..
            }
        ));
    }

    #[test]
    fn the_same_channel_configured_twice_is_refused_never_last_one_wins() {
        let error = resolve_client_channels(vec![raw(&"ab".repeat(32)), raw(&"AB".repeat(32))])
            .unwrap_err();
        assert!(matches!(error, ConfigError::ClientChannelDuplicate { .. }));
    }

    #[test]
    fn no_configured_channels_is_valid_and_records_nothing() {
        assert!(resolve_client_channels(vec![]).expect("valid").is_empty());
    }
}
