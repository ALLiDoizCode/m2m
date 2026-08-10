use std::collections::HashSet;

use serde::Deserialize;

use crate::client_channel::{is_base58_32_bytes, parse_evm_address, parse_hex_bytes, to_hex};
use crate::error::ConfigError;
use crate::settlement::SettlementChain;

/// One `[[peer_channels]]` entry as written in the config file, in either
/// chain shape this connector accepts (issue #759): EVM
/// ([`RawEvmPeerChannel`]) or Solana ([`RawSolanaPeerChannel`]).
/// `#[serde(untagged)]` picks whichever shape matches -- the same pattern
/// [`crate::client_channel::RawClientChannel`] already uses for its own
/// per-chain shapes, and for the same reason: the EVM shape requires
/// `channel_id`/`chain_id`/`token_network` and forbids `channel_account`/
/// `program_id`, the Solana shape the reverse, and each variant is
/// `deny_unknown_fields` so the two can never blend.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum RawPeerChannel {
    Evm(RawEvmPeerChannel),
    Solana(RawSolanaPeerChannel),
}

/// `[[peer_channels]]`'s original (and, before issue #759, only) shape: the
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
/// `deny_unknown_fields`: a dropped `counterparty_key` here would be a
/// dropped authorization decision, exactly as in `[[client_channels]]`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawEvmPeerChannel {
    peer_id: String,
    channel_id: String,
    counterparty_key: String,
    chain_id: u64,
    token_network: String,
}

/// `[[peer_channels]]`'s Solana shape (issue #759): the deployed
/// `payment-channel` program's channel PDA (`channel_account`, not an
/// EVM-style `channel_id`), the base58 Ed25519 public key whose signature
/// this node accepts on a claim for it, and the base58 program id that
/// deployed it.
///
/// `program_id` is `Option` here, not because it is optional -- it is not,
/// and a row missing it fails [`resolve_peer_channels`] with
/// [`ConfigError::PeerChannelMissingSolanaProgramId`] -- but so that a
/// missing field produces that named, actionable error instead of the
/// generic "data did not match any variant of untagged enum" message
/// `#[serde(untagged)]` would otherwise surface. The same posture
/// `resolve_routes` takes for a forwarded route missing `price` (ADR 0028):
/// the config shape can express the broken state, and load refuses it with
/// a reason rather than the shape being unable to describe it at all.
///
/// No `chain_id` or `token_network` -- Solana has neither an EVM-style
/// numeric chain id nor a per-token verifying contract for a declared
/// channel to name, the same reasoning
/// [`crate::client_channel::RawSolanaClientChannel`] already documents.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawSolanaPeerChannel {
    peer_id: String,
    channel_account: String,
    counterparty_key: String,
    #[serde(default)]
    program_id: Option<String>,
}

/// A fully validated `[[peer_channels]]` EVM entry. Constructed only by
/// [`resolve_peer_channels`], so a value that exists has already had its
/// channel identifier and both addresses checked -- downstream code never
/// re-validates any of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvmPeerChannelConfig {
    peer_id: String,
    channel_id: String,
    counterparty_key: [u8; 20],
    chain_id: u64,
    token_network: [u8; 20],
}

impl EvmPeerChannelConfig {
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

/// A fully validated `[[peer_channels]]` Solana entry (issue #759).
/// Constructed only by [`resolve_peer_channels`] -- `channel_account`,
/// `counterparty_key` and `program_id` have already been checked to be
/// base58-encoded 32-byte values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SolanaPeerChannelConfig {
    peer_id: String,
    channel_account: String,
    counterparty_key: String,
    program_id: String,
}

impl SolanaPeerChannelConfig {
    /// The peering relation this channel belongs to -- a `[[peers]]`
    /// entry's `id`.
    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    /// The channel's on-chain PDA, base58-encoded -- the same value a
    /// Solana peer claim names its `channelAccount` by.
    ///
    /// It may not also appear in `[[client_channels]]`
    /// ([`ConfigError::ChannelInBothNamespaces`]), the Solana counterpart
    /// of [`EvmPeerChannelConfig::channel_id`]'s own namespace rule.
    pub fn channel_account(&self) -> &str {
        &self.channel_account
    }

    /// The base58 Ed25519 public key whose signature this node accepts on
    /// a peer claim for this channel. Never the claim's own self-declared
    /// `signerPublicKey`.
    pub fn counterparty_key(&self) -> &str {
        &self.counterparty_key
    }

    /// The base58 program id of the deployed `payment-channel` program
    /// this channel was opened under -- the value a rendered outbound
    /// Solana claim's `programId` carries (issue #759). Required: unlike
    /// an EVM claim's `chainId`/`tokenNetworkAddress`, a Solana claim's
    /// `programId` is not an optional wire field
    /// (`client-edge-spec.md` §1.3, `parse_solana`), so there is no
    /// "render without it" fallback the way an unbound EVM channel has.
    pub fn program_id(&self) -> &str {
        &self.program_id
    }
}

/// One `[[peer_channels]]` entry, typed by chain (issue #759) -- an EVM
/// `channelId` and a Solana `channelAccount` name genuinely different kinds
/// of on-chain identifier, so a single shared shape would either force one
/// to fake fields it does not have or erase which chain a value came from.
/// The same reason [`crate::ClientChannelConfig`] is an enum rather than
/// one struct with optional fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerChannelConfig {
    Evm(EvmPeerChannelConfig),
    Solana(SolanaPeerChannelConfig),
}

impl PeerChannelConfig {
    /// The peering relation this channel belongs to, whichever chain it is
    /// on.
    pub fn peer_id(&self) -> &str {
        match self {
            PeerChannelConfig::Evm(evm) => evm.peer_id(),
            PeerChannelConfig::Solana(solana) => solana.peer_id(),
        }
    }

    /// The chain this declared channel lives on.
    pub fn chain(&self) -> SettlementChain {
        match self {
            PeerChannelConfig::Evm(_) => SettlementChain::Evm,
            PeerChannelConfig::Solana(_) => SettlementChain::Solana,
        }
    }
}

fn resolve_evm_peer_channel(raw: RawEvmPeerChannel) -> Result<EvmPeerChannelConfig, ConfigError> {
    let channel_id = parse_hex_bytes::<32>(&raw.channel_id).ok_or_else(|| {
        ConfigError::PeerChannelInvalidId {
            value: raw.channel_id.clone(),
        }
    })?;
    let counterparty_key = parse_evm_address(&raw.counterparty_key).ok_or_else(|| {
        ConfigError::PeerChannelInvalidAddress {
            field: "counterparty_key",
            value: raw.counterparty_key.clone(),
        }
    })?;
    let token_network = parse_evm_address(&raw.token_network).ok_or_else(|| {
        ConfigError::PeerChannelInvalidAddress {
            field: "token_network",
            value: raw.token_network.clone(),
        }
    })?;
    Ok(EvmPeerChannelConfig {
        peer_id: raw.peer_id,
        channel_id: to_hex(&channel_id),
        counterparty_key,
        chain_id: raw.chain_id,
        token_network,
    })
}

fn resolve_solana_peer_channel(
    raw: RawSolanaPeerChannel,
) -> Result<SolanaPeerChannelConfig, ConfigError> {
    if !is_base58_32_bytes(&raw.channel_account) {
        return Err(ConfigError::PeerChannelInvalidSolanaAccount {
            field: "channel_account",
            value: raw.channel_account,
        });
    }
    if !is_base58_32_bytes(&raw.counterparty_key) {
        return Err(ConfigError::PeerChannelInvalidSolanaAccount {
            field: "counterparty_key",
            value: raw.counterparty_key,
        });
    }
    let program_id =
        raw.program_id
            .ok_or_else(|| ConfigError::PeerChannelMissingSolanaProgramId {
                peer_id: raw.peer_id.clone(),
            })?;
    if !is_base58_32_bytes(&program_id) {
        return Err(ConfigError::PeerChannelInvalidSolanaAccount {
            field: "program_id",
            value: program_id,
        });
    }
    Ok(SolanaPeerChannelConfig {
        peer_id: raw.peer_id,
        channel_account: raw.channel_account,
        counterparty_key: raw.counterparty_key,
        program_id,
    })
}

pub(crate) fn resolve_peer_channels(
    raw: Vec<RawPeerChannel>,
) -> Result<Vec<PeerChannelConfig>, ConfigError> {
    let mut seen_evm = HashSet::with_capacity(raw.len());
    let mut seen_solana = HashSet::with_capacity(raw.len());
    let mut channels = Vec::with_capacity(raw.len());

    for channel in raw {
        let channel = match channel {
            RawPeerChannel::Evm(evm) => {
                let evm = resolve_evm_peer_channel(evm)?;
                // Two rows for one channel is the same double-count hazard
                // `ChannelInBothNamespaces` closes across namespaces, closed
                // here within one: whichever row's counterparty key won
                // would be whichever the loop happened to see last.
                if !seen_evm.insert(evm.channel_id.clone()) {
                    return Err(ConfigError::PeerChannelDuplicate {
                        value: evm.channel_id,
                    });
                }
                PeerChannelConfig::Evm(evm)
            }
            RawPeerChannel::Solana(solana) => {
                let solana = resolve_solana_peer_channel(solana)?;
                if !seen_solana.insert(solana.channel_account.clone()) {
                    return Err(ConfigError::PeerChannelDuplicate {
                        value: solana.channel_account,
                    });
                }
                PeerChannelConfig::Solana(solana)
            }
        };
        channels.push(channel);
    }

    Ok(channels)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHANNEL: &str = "0xaaaabbbbccccddddeeeeffff00001111aaaabbbbccccddddeeeeffff00001111";
    const KEY: &str = "0x2222222222222222222222222222222222222222";
    const NETWORK: &str = "0x3333333333333333333333333333333333333333";

    /// A real base58-encoded 32-byte value -- used wherever a test needs a
    /// well-formed Solana account/key without caring which one.
    const SOME_SOLANA_ACCOUNT: &str = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
    const ANOTHER_SOLANA_ACCOUNT: &str = "8pM1DN3RiT8vbom5u1sNryaNT1nyL8CTTW3b5PwWXRBH";

    fn raw(peer_id: &str, channel_id: &str) -> RawPeerChannel {
        RawPeerChannel::Evm(RawEvmPeerChannel {
            peer_id: peer_id.to_string(),
            channel_id: channel_id.to_string(),
            counterparty_key: KEY.to_string(),
            chain_id: 31_337,
            token_network: NETWORK.to_string(),
        })
    }

    fn raw_solana(
        peer_id: &str,
        channel_account: &str,
        program_id: Option<&str>,
    ) -> RawPeerChannel {
        RawPeerChannel::Solana(RawSolanaPeerChannel {
            peer_id: peer_id.to_string(),
            channel_account: channel_account.to_string(),
            counterparty_key: ANOTHER_SOLANA_ACCOUNT.to_string(),
            program_id: program_id.map(str::to_string),
        })
    }

    #[test]
    fn resolves_and_canonicalizes_a_row() {
        let channels = resolve_peer_channels(vec![raw(
            "store",
            &CHANNEL.to_uppercase().replace("0X", "0x"),
        )])
        .expect("resolve");

        assert_eq!(channels.len(), 1);
        let PeerChannelConfig::Evm(channel) = &channels[0] else {
            panic!("expected an EVM channel");
        };
        assert_eq!(channels[0].peer_id(), "store");
        assert_eq!(channel.channel_id(), CHANNEL);
        assert_eq!(channel.chain_id(), 31_337);
        assert_eq!(channel.counterparty_key(), [0x22u8; 20]);
        assert_eq!(channel.token_network(), [0x33u8; 20]);
        assert_eq!(channels[0].chain(), SettlementChain::Evm);
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
        let RawPeerChannel::Evm(mut entry) = raw("store", CHANNEL) else {
            unreachable!()
        };
        entry.counterparty_key = "0x12".to_string();

        let result = resolve_peer_channels(vec![RawPeerChannel::Evm(entry)]);

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

    /// Issue #759's AC: a `[[peer_channels]]` entry can declare a Solana
    /// channel -- `channel_account`/`counterparty_key`/`program_id` rather
    /// than `channel_id`/`chain_id`/`token_network` -- and parses into a
    /// distinctly typed [`PeerChannelConfig::Solana`].
    #[test]
    fn a_solana_peer_channel_is_declared_and_typed_distinctly_from_evm() {
        let channels = resolve_peer_channels(vec![raw_solana(
            "store",
            SOME_SOLANA_ACCOUNT,
            Some(ANOTHER_SOLANA_ACCOUNT),
        )])
        .expect("valid");

        let PeerChannelConfig::Solana(solana) = &channels[0] else {
            panic!("expected a Solana channel");
        };
        assert_eq!(channels[0].peer_id(), "store");
        assert_eq!(solana.channel_account(), SOME_SOLANA_ACCOUNT);
        assert_eq!(solana.counterparty_key(), ANOTHER_SOLANA_ACCOUNT);
        assert_eq!(solana.program_id(), ANOTHER_SOLANA_ACCOUNT);
        assert_eq!(channels[0].chain(), SettlementChain::Solana);
    }

    /// The named AC: a Solana row with no `program_id` fails load with an
    /// actionable, named error -- not a generic untagged-enum mismatch.
    #[test]
    fn a_solana_peer_channel_with_no_program_id_is_refused() {
        let result = resolve_peer_channels(vec![raw_solana("store", SOME_SOLANA_ACCOUNT, None)]);

        assert!(matches!(
            result,
            Err(ConfigError::PeerChannelMissingSolanaProgramId { ref peer_id }) if peer_id == "store"
        ));
    }

    #[test]
    fn a_solana_channel_account_that_is_not_valid_base58_32_bytes_is_refused() {
        let result = resolve_peer_channels(vec![raw_solana(
            "store",
            "not-base58!!!",
            Some(ANOTHER_SOLANA_ACCOUNT),
        )]);

        assert!(matches!(
            result,
            Err(ConfigError::PeerChannelInvalidSolanaAccount {
                field: "channel_account",
                ..
            })
        ));
    }

    #[test]
    fn a_solana_program_id_that_is_not_valid_base58_32_bytes_is_refused() {
        let result = resolve_peer_channels(vec![raw_solana(
            "store",
            SOME_SOLANA_ACCOUNT,
            Some("not-base58!!!"),
        )]);

        assert!(matches!(
            result,
            Err(ConfigError::PeerChannelInvalidSolanaAccount {
                field: "program_id",
                ..
            })
        ));
    }

    #[test]
    fn the_same_solana_channel_configured_twice_is_refused() {
        let result = resolve_peer_channels(vec![
            raw_solana("store", SOME_SOLANA_ACCOUNT, Some(ANOTHER_SOLANA_ACCOUNT)),
            raw_solana("relay", SOME_SOLANA_ACCOUNT, Some(ANOTHER_SOLANA_ACCOUNT)),
        ]);

        assert!(matches!(
            result,
            Err(ConfigError::PeerChannelDuplicate { .. })
        ));
    }

    /// EVM and Solana peer channels are separate namespaces, the same as
    /// `[[client_channels]]`'s own split: an EVM `channel_id` and a Solana
    /// `channel_account` can coexist, and a duplicate check on one chain
    /// must never trip on the other's entry.
    #[test]
    fn evm_and_solana_peer_channels_coexist_without_colliding() {
        let channels = resolve_peer_channels(vec![
            raw("store", CHANNEL),
            raw_solana("relay", SOME_SOLANA_ACCOUNT, Some(ANOTHER_SOLANA_ACCOUNT)),
        ])
        .expect("valid: distinct chains never collide");
        assert_eq!(channels.len(), 2);
    }

    /// `#[serde(untagged)]` really does dispatch on the config file's own
    /// shape: this is the TOML-level proof, not just the constructor-level
    /// one above.
    #[test]
    fn toml_deserializes_each_shape_into_its_own_raw_variant() {
        let raw: RawPeerChannel = toml::from_str(&format!(
            r#"
peer_id = "store"
channel_id = "0x{}"
counterparty_key = "0x00000000000000000000000000000000000000aa"
chain_id = 8453
token_network = "0x00000000000000000000000000000000000000bb"
"#,
            "ab".repeat(32)
        ))
        .expect("valid EVM TOML");
        assert!(matches!(raw, RawPeerChannel::Evm(_)));

        let raw: RawPeerChannel = toml::from_str(&format!(
            r#"
peer_id = "store"
channel_account = "{SOME_SOLANA_ACCOUNT}"
counterparty_key = "{ANOTHER_SOLANA_ACCOUNT}"
program_id = "{ANOTHER_SOLANA_ACCOUNT}"
"#
        ))
        .expect("valid Solana TOML");
        assert!(matches!(raw, RawPeerChannel::Solana(_)));
    }
}
