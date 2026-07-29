//! Per-channel counterparty registry for the client edge (issue #558):
//! which key this connector accepts a claim's signature from, for each
//! channel it has a record of.
//!
//! This is what turns `client-edge-spec.md` §1.3 step 4 from a
//! self-referential check into a real one. A claim carries its own
//! `signerAddress`/`signerPublicKey`, but a forger can put anything there
//! -- signing correctly with a freshly generated key and declaring
//! themself the payer costs nothing. The only party whose signature means
//! anything on a channel is that channel's counterparty, and a
//! counterparty is a property of the channel, not of the claim. So it is
//! recorded here, keyed by the channel, and a claim gets no say in it:
//! [`crate::ClientClaimGate`] reads the signer -- and, for EVM, the EIP-712
//! domain the digest is computed under (ADR 0024) -- out of this registry
//! and never out of the claim.
//!
//! Deliberately the same shape the peer wire already settled on:
//! `connector_runtime::ClaimBook` keeps a `channel_id -> Address` map plus
//! a per-channel `ChannelDomain` for exactly this reason (issue #575), and
//! refuses a claim naming a channel it has no record of as
//! `ClaimRejectReason::UnknownChannel`. This is that rule at the other
//! edge, over the client edge's own claim shapes, since a client-edge
//! claim's channel is never a peer-wire channel.
//!
//! **An unpopulated registry refuses every claim.** That is the intended
//! failure mode, not an oversight: the only alternative to "no record of
//! this channel" is trusting what the claim says about itself, which is
//! the hole this module exists to close. Populating it from a settlement
//! backend's own `ChannelState::counterparty` at startup is issue #556's
//! job (arming the connector); until that lands, a node that wants to
//! accept claims builds its registry explicitly and mounts the edge with
//! [`crate::router_with_channels`].

use std::collections::HashMap;

use connector_signer::Address;

/// A channel identifier that is not the on-chain value its chain's claims
/// are signed over -- a `channelId` that is not a 32-byte `bytes32`, or a
/// `channelAccount` that is not a 32-byte Solana account. Refused at
/// registration rather than hashed or truncated into shape, matching
/// `connector_runtime::InvalidChannelId`'s rule on the peer wire (issue
/// #575).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidChannelIdentifier(pub String);

impl std::fmt::Display for InvalidChannelIdentifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "channel identifier {:?} is not a 32-byte on-chain identifier",
            self.0
        )
    }
}

impl std::error::Error for InvalidChannelIdentifier {}

/// Everything this connector needs to verify an EVM claim on one channel
/// without believing anything the claim says about itself: whose signature
/// it accepts, and the EIP-712 domain (ADR 0024) that signature must have
/// been produced under. `chain_id` and `token_network_address` are
/// per-channel rather than node-wide for the same reason the peer wire's
/// `ChannelDomain` is (issue #566): each token gets its own `TokenNetwork`,
/// and therefore its own `verifyingContract`, so there is no single domain
/// a node could default to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EvmChannel {
    /// The address whose signature this connector accepts on a claim for
    /// this channel -- recovered from the signature, never read from the
    /// claim's own `signerAddress`.
    pub counterparty: Address,
    pub chain_id: u64,
    pub token_network_address: Address,
}

/// The channels this connector has a record of, and the counterparty it
/// accepts a claim's signature from on each. EVM and Solana are separate
/// namespaces -- a `channelId` and a `channelAccount` are different kinds
/// of thing and can never satisfy each other, the same way
/// `connector_domain::ClientClaim::channel_key` namespaces the watermark
/// map.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ClientChannelRegistry {
    evm: HashMap<[u8; 32], EvmChannel>,
    solana: HashMap<[u8; 32], [u8; 32]>,
}

impl ClientChannelRegistry {
    /// An empty registry -- one that refuses every claim, since it has a
    /// record of no channel at all. See this module's own doc comment.
    pub fn new() -> ClientChannelRegistry {
        ClientChannelRegistry::default()
    }

    /// Record `channel_id`'s counterparty and EIP-712 domain. `channel_id`
    /// is the wire shape a claim names it by -- `0x`-prefixed (or bare)
    /// 64-character hex -- and is refused as
    /// [`InvalidChannelIdentifier`], never coerced, if it is not.
    pub fn record_evm(
        &mut self,
        channel_id: &str,
        channel: EvmChannel,
    ) -> Result<(), InvalidChannelIdentifier> {
        let key = decode_hex_bytes::<32>(channel_id)
            .ok_or_else(|| InvalidChannelIdentifier(channel_id.to_string()))?;
        self.evm.insert(key, channel);
        Ok(())
    }

    /// Record `channel_account`'s counterparty: the Ed25519 public key
    /// whose signature this connector accepts on a Solana claim for that
    /// channel, never the claim's own `signerPublicKey`. Both are base58,
    /// the shape they ride the wire in.
    pub fn record_solana(
        &mut self,
        channel_account: &str,
        counterparty: &str,
    ) -> Result<(), InvalidChannelIdentifier> {
        let key = decode_base58_bytes::<32>(channel_account)
            .ok_or_else(|| InvalidChannelIdentifier(channel_account.to_string()))?;
        let counterparty = decode_base58_bytes::<32>(counterparty)
            .ok_or_else(|| InvalidChannelIdentifier(counterparty.to_string()))?;
        self.solana.insert(key, counterparty);
        Ok(())
    }

    /// Whether this registry has a record of no channel at all -- every
    /// claim presented to a gate holding it is refused as
    /// [`crate::ClaimIngestRejection::UnknownChannel`].
    pub fn is_empty(&self) -> bool {
        self.evm.is_empty() && self.solana.is_empty()
    }

    pub(crate) fn evm(&self, channel_id: &[u8; 32]) -> Option<&EvmChannel> {
        self.evm.get(channel_id)
    }

    pub(crate) fn solana(&self, channel_account: &[u8; 32]) -> Option<&[u8; 32]> {
        self.solana.get(channel_account)
    }
}

/// Decode a `0x`-prefixed (or bare) hex string into exactly `N` bytes, or
/// `None` for anything malformed or the wrong length -- never a panic, same
/// as every other step of the claim gate (issue #506's "refused as a
/// validation failure, never as a crash").
pub(crate) fn decode_hex_bytes<const N: usize>(s: &str) -> Option<[u8; N]> {
    hex::decode(s.strip_prefix("0x").unwrap_or(s))
        .ok()?
        .try_into()
        .ok()
}

/// Decode a base58 string into exactly `N` bytes, or `None` for anything
/// malformed or the wrong length.
pub(crate) fn decode_base58_bytes<const N: usize>(s: &str) -> Option<[u8; N]> {
    bs58::decode(s).into_vec().ok()?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evm_channel() -> EvmChannel {
        EvmChannel {
            counterparty: [0x11; 20],
            chain_id: 8453,
            token_network_address: [0x42; 20],
        }
    }

    #[test]
    fn a_recorded_evm_channel_is_found_under_the_id_it_was_recorded_by() {
        let mut registry = ClientChannelRegistry::new();
        let channel_id = format!("0x{}", "ab".repeat(32));
        registry
            .record_evm(&channel_id, evm_channel())
            .expect("a 32-byte hex channel id");

        let key = decode_hex_bytes::<32>(&channel_id).unwrap();
        assert_eq!(registry.evm(&key), Some(&evm_channel()));
    }

    #[test]
    fn the_0x_prefix_is_not_part_of_a_channels_identity() {
        let mut registry = ClientChannelRegistry::new();
        registry
            .record_evm(&"ab".repeat(32), evm_channel())
            .expect("a bare 32-byte hex channel id");

        // A claim naming the same channel with the `0x` prefix names the
        // same channel -- the prefix is notation, not identity.
        let key = decode_hex_bytes::<32>(&format!("0x{}", "ab".repeat(32))).unwrap();
        assert_eq!(registry.evm(&key), Some(&evm_channel()));
    }

    #[test]
    fn an_id_that_is_not_a_32_byte_channel_is_refused_never_coerced() {
        let mut registry = ClientChannelRegistry::new();
        assert_eq!(
            registry.record_evm("0xdeadbeef", evm_channel()),
            Err(InvalidChannelIdentifier("0xdeadbeef".to_string()))
        );
        assert!(
            registry.is_empty(),
            "nothing was recorded under a coerced id"
        );
    }

    #[test]
    fn a_recorded_solana_channel_is_found_under_the_account_it_was_recorded_by() {
        let mut registry = ClientChannelRegistry::new();
        let account = bs58::encode([3u8; 32]).into_string();
        let counterparty = bs58::encode([7u8; 32]).into_string();
        registry
            .record_solana(&account, &counterparty)
            .expect("a 32-byte base58 account");

        assert_eq!(registry.solana(&[3u8; 32]), Some(&[7u8; 32]));
    }

    #[test]
    fn evm_and_solana_channels_are_separate_namespaces() {
        let mut registry = ClientChannelRegistry::new();
        registry
            .record_evm(&"03".repeat(32), evm_channel())
            .expect("a 32-byte hex channel id");

        // The same 32 bytes, presented as a Solana account, is not that
        // channel: an EVM record can never answer for a Solana claim.
        assert_eq!(registry.solana(&[3u8; 32]), None);
    }

    #[test]
    fn a_fresh_registry_has_a_record_of_no_channel() {
        assert!(ClientChannelRegistry::new().is_empty());
    }
}
