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
/// `channel_id`/`chain_id`/`token_network` and forbids `channel_account`,
/// the Solana shape the reverse, and each variant is
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
/// EVM-style `channel_id`) and the base58 Ed25519 public key whose
/// signature this node accepts on a claim for it.
///
/// **`program_id` is not one of this row's facts (issue #1128).** It is
/// read from `[settlement.solana]`, the one program this node can actually
/// redeem a claim under, exactly as `[[client_channels]]`'s Solana shape
/// has read it since #1082. The field survives here only so a config that
/// still writes it is refused **by name**
/// ([`ConfigError::PeerChannelProgramIdRemoved`]) rather than dropped or
/// lost in `#[serde(untagged)]`'s "matched no variant" -- the posture ADR
/// 0009 requires of every removed key, and the same one `RawPeer`'s
/// `addr`/`ceiling` fields take. `toml::Value` rather than `String` for the
/// same reason `addr` uses it: `program_id = 5` is still the removed key,
/// and must be named as such rather than failing shape-match.
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
    program_id: Option<toml::Value>,
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
///
/// `program_id` is a field of this value but **not** of the config row it
/// came from (issue #1128): it is copied in from `[settlement.solana]`
/// during resolution, so every Solana peer channel a loaded `Config` holds
/// names the program this node settles under, by construction rather than
/// by the operator having typed the same address twice and got it right.
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
    /// this channel is judged and settled under -- the value a rendered
    /// outbound Solana claim's `programId` carries (issue #759), and the
    /// value ADR 0053 binds into the signed message of every claim on this
    /// channel in either direction.
    ///
    /// **Always `[settlement.solana] program_id` (issue #1128.)** Not a
    /// declared fact of the row: the row used to carry one, nothing
    /// compared the two, and a node whose row and settlement table
    /// disagreed accepted peer claims signed under one program while
    /// redeeming under the other -- carriage rendered for money it could
    /// never collect. There is exactly one Solana program a node can submit
    /// a redemption to, so there is exactly one a peer channel can live
    /// under, and it is read from the table that names it.
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

/// `settlement_program_id` is `[settlement.solana] program_id`, or `None`
/// for a node with no `[settlement.solana]` table at all. It is the only
/// source of a Solana peer channel's program id (issue #1128); the row is
/// refused outright if it tries to name a second one, and refused again if
/// there is no table to read the first from.
fn resolve_solana_peer_channel(
    raw: RawSolanaPeerChannel,
    settlement_program_id: Option<&str>,
) -> Result<SolanaPeerChannelConfig, ConfigError> {
    // Before the shape checks, because "you wrote a key that no longer
    // exists" explains the file better than "one of your other values is
    // malformed" when both are true -- and because this is the branch that
    // must never fall through to a silent ignore (ADR 0009).
    if raw.program_id.is_some() {
        return Err(ConfigError::PeerChannelProgramIdRemoved {
            peer_id: raw.peer_id,
        });
    }
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
    let Some(program_id) = settlement_program_id else {
        return Err(ConfigError::PeerChannelWithoutSolanaSettlement {
            peer_id: raw.peer_id,
        });
    };
    // `[settlement.solana]`'s own resolver checks this value for
    // non-emptiness only, and the settlement backend does not parse it
    // until it dials a chain. A peer channel needs it to be a real
    // 32-byte address before that, because it is now part of what every
    // claim on this channel is verified against.
    if !is_base58_32_bytes(program_id) {
        return Err(ConfigError::PeerChannelSolanaSettlementProgramIdInvalid {
            peer_id: raw.peer_id,
            value: program_id.to_string(),
        });
    }
    Ok(SolanaPeerChannelConfig {
        peer_id: raw.peer_id,
        channel_account: raw.channel_account,
        counterparty_key: raw.counterparty_key,
        program_id: program_id.to_string(),
    })
}

pub(crate) fn resolve_peer_channels(
    raw: Vec<RawPeerChannel>,
    settlement_program_id: Option<&str>,
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
                let solana = resolve_solana_peer_channel(solana, settlement_program_id)?;
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

    /// The program id `[settlement.solana]` names in these tests -- the one
    /// place a Solana peer channel's program can come from since issue
    /// #1128.
    const SETTLEMENT_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

    /// `program_id` is what a config file that still writes the removed key
    /// looks like; `None` is the shape every correct file now has.
    fn raw_solana(
        peer_id: &str,
        channel_account: &str,
        program_id: Option<&str>,
    ) -> RawPeerChannel {
        RawPeerChannel::Solana(RawSolanaPeerChannel {
            peer_id: peer_id.to_string(),
            channel_account: channel_account.to_string(),
            counterparty_key: ANOTHER_SOLANA_ACCOUNT.to_string(),
            program_id: program_id.map(|id| toml::Value::String(id.to_string())),
        })
    }

    /// `resolve_peer_channels` for a node whose `[settlement.solana]` names
    /// [`SETTLEMENT_PROGRAM_ID`] -- the ordinary case.
    fn resolve(raw: Vec<RawPeerChannel>) -> Result<Vec<PeerChannelConfig>, ConfigError> {
        resolve_peer_channels(raw, Some(SETTLEMENT_PROGRAM_ID))
    }

    #[test]
    fn resolves_and_canonicalizes_a_row() {
        let channels = resolve(vec![raw(
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
        let result = resolve(vec![raw("store", "0xnope")]);

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

        let result = resolve(vec![RawPeerChannel::Evm(entry)]);

        assert!(matches!(
            result,
            Err(ConfigError::PeerChannelInvalidAddress { field, .. }) if field == "counterparty_key"
        ));
    }

    #[test]
    fn rejects_a_channel_named_twice() {
        let result = resolve(vec![raw("store", CHANNEL), raw("relay", CHANNEL)]);

        assert!(matches!(
            result,
            Err(ConfigError::PeerChannelDuplicate { .. })
        ));
    }

    /// Issue #759's AC, as issue #1128 leaves it: a `[[peer_channels]]`
    /// entry can declare a Solana channel -- `channel_account`/
    /// `counterparty_key` rather than `channel_id`/`chain_id`/
    /// `token_network` -- and parses into a distinctly typed
    /// [`PeerChannelConfig::Solana`].
    #[test]
    fn a_solana_peer_channel_is_declared_and_typed_distinctly_from_evm() {
        let channels =
            resolve(vec![raw_solana("store", SOME_SOLANA_ACCOUNT, None)]).expect("valid");

        let PeerChannelConfig::Solana(solana) = &channels[0] else {
            panic!("expected a Solana channel");
        };
        assert_eq!(channels[0].peer_id(), "store");
        assert_eq!(solana.channel_account(), SOME_SOLANA_ACCOUNT);
        assert_eq!(solana.counterparty_key(), ANOTHER_SOLANA_ACCOUNT);
        assert_eq!(channels[0].chain(), SettlementChain::Solana);
    }

    /// Issue #1128, the whole point: a Solana peer channel's program id is
    /// the settlement program's, read from `[settlement.solana]` and not
    /// from the row -- so the two cannot disagree, and a node cannot verify
    /// a peer claim under a program it does not settle with.
    #[test]
    fn a_solana_peer_channel_takes_its_program_id_from_the_settlement_table() {
        let channels =
            resolve(vec![raw_solana("store", SOME_SOLANA_ACCOUNT, None)]).expect("valid");

        let PeerChannelConfig::Solana(solana) = &channels[0] else {
            panic!("expected a Solana channel");
        };
        assert_eq!(solana.program_id(), SETTLEMENT_PROGRAM_ID);
    }

    /// The removed key is refused **by name** rather than ignored or lost
    /// in `#[serde(untagged)]`'s "matched no variant" (ADR 0009, issue
    /// #1128). Refused even when it agrees with `[settlement.solana]`: the
    /// key is gone, and a file that still writes it is a file whose author
    /// believes it decides something.
    #[test]
    fn a_solana_peer_channel_that_still_declares_a_program_id_is_refused_by_name() {
        let result = resolve(vec![raw_solana(
            "store",
            SOME_SOLANA_ACCOUNT,
            Some(SETTLEMENT_PROGRAM_ID),
        )]);

        assert!(matches!(
            result,
            Err(ConfigError::PeerChannelProgramIdRemoved { ref peer_id }) if peer_id == "store"
        ));
    }

    /// The failure issue #1128 is actually about, in the shape an operator
    /// writes it: a row left behind after a program redeploy. It used to
    /// load, and quietly split the node's verification program from its
    /// settlement program. Now it does not load at all.
    #[test]
    fn a_solana_peer_channel_naming_a_program_the_node_does_not_settle_with_is_refused() {
        let result = resolve(vec![raw_solana(
            "store",
            SOME_SOLANA_ACCOUNT,
            Some(ANOTHER_SOLANA_ACCOUNT),
        )]);

        assert!(matches!(
            result,
            Err(ConfigError::PeerChannelProgramIdRemoved { .. })
        ));
    }

    /// A value of the wrong TOML *type* is still the removed key, and must
    /// be named as such -- the reason the field is `toml::Value` rather
    /// than `Option<String>`, which would have failed the untagged
    /// shape-match and surfaced "data did not match any variant" instead.
    #[test]
    fn a_removed_program_id_of_any_toml_type_is_still_named() {
        let RawPeerChannel::Solana(mut entry) = raw_solana("store", SOME_SOLANA_ACCOUNT, None)
        else {
            unreachable!()
        };
        entry.program_id = Some(toml::Value::Integer(5));

        let result = resolve(vec![RawPeerChannel::Solana(entry)]);

        assert!(matches!(
            result,
            Err(ConfigError::PeerChannelProgramIdRemoved { .. })
        ));
    }

    /// With the per-row key gone, `[settlement.solana]` is the only source
    /// of a program id -- so a node without that table cannot bind a Solana
    /// peer channel at all, and says so rather than binding one whose
    /// claims it could never redeem. The sibling of
    /// `PayChannelWithoutEvmSettlement`.
    #[test]
    fn a_solana_peer_channel_on_a_node_with_no_solana_settlement_is_refused() {
        let result =
            resolve_peer_channels(vec![raw_solana("store", SOME_SOLANA_ACCOUNT, None)], None);

        assert!(matches!(
            result,
            Err(ConfigError::PeerChannelWithoutSolanaSettlement { ref peer_id })
                if peer_id == "store"
        ));
    }

    /// `[settlement.solana]`'s own resolver checks `program_id` for
    /// non-emptiness only. A Solana peer channel needs a real address,
    /// because that value is now part of what every claim on the channel is
    /// verified against.
    #[test]
    fn a_settlement_program_id_that_is_not_base58_32_bytes_is_refused_for_a_solana_row() {
        let result = resolve_peer_channels(
            vec![raw_solana("store", SOME_SOLANA_ACCOUNT, None)],
            Some("not-base58!!!"),
        );

        assert!(matches!(
            result,
            Err(ConfigError::PeerChannelSolanaSettlementProgramIdInvalid { ref peer_id, .. })
                if peer_id == "store"
        ));
    }

    /// An EVM row on a node with no Solana settlement is untouched by any
    /// of the above -- the new refusals are Solana-shaped, and a node that
    /// settles only on EVM keeps loading exactly as it did.
    #[test]
    fn an_evm_peer_channel_needs_no_solana_settlement_table() {
        let channels =
            resolve_peer_channels(vec![raw("store", CHANNEL)], None).expect("EVM needs no Solana");
        assert_eq!(channels.len(), 1);
    }

    #[test]
    fn a_solana_channel_account_that_is_not_valid_base58_32_bytes_is_refused() {
        let result = resolve(vec![raw_solana("store", "not-base58!!!", None)]);

        assert!(matches!(
            result,
            Err(ConfigError::PeerChannelInvalidSolanaAccount {
                field: "channel_account",
                ..
            })
        ));
    }

    #[test]
    fn the_same_solana_channel_configured_twice_is_refused() {
        let result = resolve(vec![
            raw_solana("store", SOME_SOLANA_ACCOUNT, None),
            raw_solana("relay", SOME_SOLANA_ACCOUNT, None),
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
        let channels = resolve(vec![
            raw("store", CHANNEL),
            raw_solana("relay", SOME_SOLANA_ACCOUNT, None),
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
"#
        ))
        .expect("valid Solana TOML");
        assert!(matches!(raw, RawPeerChannel::Solana(_)));

        // And a file that still writes the removed key still *parses* into
        // the Solana variant -- which is the whole reason the field is kept
        // (issue #1128). If it did not, the untagged enum would answer
        // "matched no variant" and the named refusal could never be
        // reached.
        let raw: RawPeerChannel = toml::from_str(&format!(
            r#"
peer_id = "store"
channel_account = "{SOME_SOLANA_ACCOUNT}"
counterparty_key = "{ANOTHER_SOLANA_ACCOUNT}"
program_id = "{ANOTHER_SOLANA_ACCOUNT}"
"#
        ))
        .expect("the removed key must still parse, so it can be refused by name");
        let RawPeerChannel::Solana(solana) = raw else {
            panic!("expected the Solana variant");
        };
        assert!(solana.program_id.is_some());
    }
}
