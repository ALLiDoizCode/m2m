use std::collections::HashSet;

use serde::Deserialize;

use crate::client_channel::{parse_evm_address, parse_hex_bytes, to_hex};
use crate::error::ConfigError;

/// One `[[peer_channels]]` entry as written in the config file: the
/// payment channel a peering relation's claims are judged against, and the
/// EIP-712 domain they are signed under (ADR 0024).
///
/// This is the table whose **absence** made ADR 0024 inert (#620 gap 3):
/// the peer-claim mechanism was fully implemented and never wired, because
/// `ClaimBook`'s verification key and domain had no field to hang on and
/// `connector-cli::runtime::build` therefore never set them. A peering
/// without a row here can never satisfy `peer-carriage-spec.md` §1.2's P2,
/// so it can never take the peer role at all -- which is why an unbound
/// peer is a load-time error rather than a runtime surprise.
///
/// EVM-shaped only, unlike `[[client_channels]]`: §11 names `chain_id` and
/// `token_network`, both of which are EIP-712 domain inputs a Solana
/// channel has no analogue for. A Solana peering shape is a schema
/// addition, not a field this one should fake.
///
/// `deny_unknown_fields`: a dropped `counterparty_key` here would be a
/// dropped authorization decision, exactly as in `[[client_channels]]`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawPeerChannel {
    peer_id: String,
    channel_id: String,
    counterparty_key: String,
    chain_id: u64,
    token_network: String,
}

/// A fully validated `[[peer_channels]]` entry. Constructed only by
/// [`resolve_peer_channels`], so a value that exists has already had its
/// channel identifier and both addresses checked -- downstream code never
/// re-validates any of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerChannelConfig {
    peer_id: String,
    channel_id: String,
    counterparty_key: [u8; 20],
    chain_id: u64,
    token_network: [u8; 20],
}

impl PeerChannelConfig {
    /// The peering relation this channel belongs to -- a `[[peers]]`
    /// entry's `id`. A row naming an id no `[[peers]]` entry configures is
    /// [`ConfigError::PeerChannelOrphaned`].
    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    /// The channel's on-chain identifier, canonicalized to lowercase
    /// `0x`-prefixed hex however the operator wrote it -- the same value a
    /// peer claim names the channel by.
    ///
    /// It may not also appear in `[[client_channels]]`
    /// ([`ConfigError::ChannelInBothNamespaces`]): peer and client
    /// watermarks live in separate namespaces, and one channel in both
    /// would let one claim be counted as credit twice
    /// (`peer-carriage-spec.md` §1.8).
    pub fn channel_id(&self) -> &str {
        &self.channel_id
    }

    /// The address whose signature this node accepts on a peer claim for
    /// this channel -- `ClaimBook`'s verification key. Never the claim's
    /// own self-declared signer.
    pub fn counterparty_key(&self) -> [u8; 20] {
        self.counterparty_key
    }

    /// The chain this channel is deployed on: half of the EIP-712 domain
    /// its balance proofs are signed under (ADR 0024).
    pub fn chain_id(&self) -> u64 {
        self.chain_id
    }

    /// The `TokenNetwork` that verifies this channel's claims on
    /// redemption -- the EIP-712 `verifyingContract`, and the other half of
    /// the domain.
    pub fn token_network(&self) -> [u8; 20] {
        self.token_network
    }
}

pub(crate) fn resolve_peer_channels(
    raw: Vec<RawPeerChannel>,
) -> Result<Vec<PeerChannelConfig>, ConfigError> {
    let mut seen = HashSet::with_capacity(raw.len());
    let mut channels = Vec::with_capacity(raw.len());

    for channel in raw {
        let channel_id = parse_hex_bytes::<32>(&channel.channel_id).ok_or_else(|| {
            ConfigError::PeerChannelInvalidId {
                value: channel.channel_id.clone(),
            }
        })?;
        let counterparty_key = parse_evm_address(&channel.counterparty_key).ok_or_else(|| {
            ConfigError::PeerChannelInvalidAddress {
                field: "counterparty_key",
                value: channel.counterparty_key.clone(),
            }
        })?;
        let token_network = parse_evm_address(&channel.token_network).ok_or_else(|| {
            ConfigError::PeerChannelInvalidAddress {
                field: "token_network",
                value: channel.token_network.clone(),
            }
        })?;
        let channel_id = to_hex(&channel_id);
        // Two rows for one channel is the same double-count hazard
        // `ChannelInBothNamespaces` closes across namespaces, closed here
        // within one: whichever row's counterparty key won would be
        // whichever the loop happened to see last.
        if !seen.insert(channel_id.clone()) {
            return Err(ConfigError::PeerChannelDuplicate { value: channel_id });
        }
        channels.push(PeerChannelConfig {
            peer_id: channel.peer_id,
            channel_id,
            counterparty_key,
            chain_id: channel.chain_id,
            token_network,
        });
    }

    Ok(channels)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHANNEL: &str = "0xaaaabbbbccccddddeeeeffff00001111aaaabbbbccccddddeeeeffff00001111";
    const KEY: &str = "0x2222222222222222222222222222222222222222";
    const NETWORK: &str = "0x3333333333333333333333333333333333333333";

    fn raw(peer_id: &str, channel_id: &str) -> RawPeerChannel {
        RawPeerChannel {
            peer_id: peer_id.to_string(),
            channel_id: channel_id.to_string(),
            counterparty_key: KEY.to_string(),
            chain_id: 31_337,
            token_network: NETWORK.to_string(),
        }
    }

    #[test]
    fn resolves_and_canonicalizes_a_row() {
        let channels = resolve_peer_channels(vec![raw(
            "store",
            &CHANNEL.to_uppercase().replace("0X", "0x"),
        )])
        .expect("resolve");

        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].peer_id(), "store");
        assert_eq!(channels[0].channel_id(), CHANNEL);
        assert_eq!(channels[0].chain_id(), 31_337);
        assert_eq!(channels[0].counterparty_key(), [0x22u8; 20]);
        assert_eq!(channels[0].token_network(), [0x33u8; 20]);
    }

    #[test]
    fn rejects_a_malformed_channel_id() {
        let result = resolve_peer_channels(vec![raw("store", "0xnope")]);

        assert!(matches!(
            result,
            Err(ConfigError::PeerChannelInvalidId { ref value }) if value == "0xnope"
        ));
    }

    #[test]
    fn rejects_a_malformed_counterparty_key() {
        let mut entry = raw("store", CHANNEL);
        entry.counterparty_key = "0x12".to_string();

        let result = resolve_peer_channels(vec![entry]);

        assert!(matches!(
            result,
            Err(ConfigError::PeerChannelInvalidAddress { field, .. }) if field == "counterparty_key"
        ));
    }

    #[test]
    fn rejects_a_channel_named_twice() {
        let result = resolve_peer_channels(vec![raw("store", CHANNEL), raw("relay", CHANNEL)]);

        assert!(matches!(
            result,
            Err(ConfigError::PeerChannelDuplicate { .. })
        ));
    }
}
