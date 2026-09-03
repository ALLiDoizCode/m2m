//! A `TokenNetwork` channel id: the 32 bytes themselves, the
//! [`ChannelId`] string every layer above this crate carries them as, and
//! -- since ADR 0059 (issue #1158) -- the derivation that produces one
//! from the pair of participants it belongs to.
//!
//! **Derivation is a settlement-backend fact and stops here.** Above this
//! crate a channel id is 32 opaque bytes: the packet path, claim
//! validation and the client edge neither know nor may assume that a
//! particular id can be recomputed. Only code that *constructs* one --
//! this module, and `TokenNetwork.openChannel` itself -- is entitled to
//! the preimage.

use ethers::types::{Address, U256};
use ethers::utils::keccak256;

use connector_settlement::{ChannelId, SettlementError};

/// Put a pair of participants into the order `TokenNetwork.openChannel`
/// normalises them to -- ascending by address, `p1 < p2`
/// (`TokenNetwork.sol`, "Normalize participant order") -- so that the two
/// sides of a channel derive the same id from opposite arguments. The
/// twin of `connector_settlement_solana::wire::sort_participants`, whose
/// channel PDA has seeded on the sorted pair all along.
pub fn sort_participants(a: Address, b: Address) -> (Address, Address) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

/// `keccak256(abi.encodePacked(p1, p2, epoch))` over the sorted pair --
/// byte for byte what `TokenNetwork.openChannel` computes (ADR 0059).
/// `abi.encodePacked` of `(address, address, uint256)` is 20 + 20 + 32
/// bytes with no padding and no length prefixes, which is what the
/// concatenation below is.
///
/// `epoch` is the pair's own `channelEpoch(p1, p2)`, read from the chain
/// -- **not** a number this process may invent. It advances only when a
/// channel of theirs settles, which is what lets a pair close and open
/// again; a caller that guesses it derives an id nothing is at.
pub fn derive_channel_id(a: Address, b: Address, epoch: U256) -> ChannelId {
    let (p1, p2) = sort_participants(a, b);
    let mut preimage = [0u8; 20 + 20 + 32];
    preimage[..20].copy_from_slice(p1.as_bytes());
    preimage[20..40].copy_from_slice(p2.as_bytes());
    epoch.to_big_endian(&mut preimage[40..]);
    format_channel_id(keccak256(preimage))
}

/// `TokenNetwork`'s channel id as `0x`-prefixed, zero-padded lowercase hex
/// -- the same shape `connector_runtime::claim::parse_channel_id` already
/// accepts for a peer channel id (issue #575's AC4), so an id this crate
/// hands back is usable there unchanged.
pub fn format_channel_id(id: [u8; 32]) -> ChannelId {
    let mut hex = String::with_capacity(2 + 64);
    hex.push_str("0x");
    for byte in id {
        hex.push_str(&format!("{byte:02x}"));
    }
    ChannelId(hex)
}

/// The inverse of [`format_channel_id`]. A channel id that does not parse
/// as 32 bytes of hex is reported as [`SettlementError::ChannelNotFound`]
/// rather than a distinct parse-error variant -- from this port's
/// perspective a malformed id and one nothing was ever opened at mean the
/// same thing: there is no channel to operate on.
pub fn parse_channel_id(channel: &ChannelId) -> Result<[u8; 32], SettlementError> {
    let hex_digits = channel.0.strip_prefix("0x").unwrap_or(channel.0.as_str());
    if hex_digits.len() != 64 || !hex_digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(SettlementError::ChannelNotFound(channel.clone()));
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex_digits[i * 2..i * 2 + 2], 16)
            .map_err(|_| SettlementError::ChannelNotFound(channel.clone()))?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address(byte: u8) -> Address {
        Address::from_slice(&[byte; 20])
    }

    #[test]
    fn a_pair_derives_the_same_id_from_either_side() {
        let (a, b) = (address(0x11), address(0x22));
        assert_eq!(
            derive_channel_id(a, b, U256::zero()),
            derive_channel_id(b, a, U256::zero())
        );
    }

    #[test]
    fn a_different_counterparty_derives_a_different_id() {
        let a = address(0x11);
        assert_ne!(
            derive_channel_id(a, address(0x22), U256::zero()),
            derive_channel_id(a, address(0x33), U256::zero())
        );
    }

    #[test]
    fn a_later_epoch_derives_a_different_id_for_the_same_pair() {
        let (a, b) = (address(0x11), address(0x22));
        assert_ne!(
            derive_channel_id(a, b, U256::zero()),
            derive_channel_id(a, b, U256::one())
        );
    }

    /// The preimage is 72 bytes with no padding: two 20-byte addresses and
    /// a big-endian 32-byte epoch, exactly `abi.encodePacked`. Hashing the
    /// same three fields any other way (32-byte-padded addresses, a
    /// little-endian epoch) produces a different, useless id, so the
    /// layout is asserted here rather than only implied by the chain
    /// tests.
    #[test]
    fn the_preimage_is_abi_encode_packed_of_the_sorted_pair_and_the_epoch() {
        let (a, b) = (address(0x22), address(0x11));
        let mut expected = Vec::new();
        expected.extend_from_slice(&[0x11u8; 20]);
        expected.extend_from_slice(&[0x22u8; 20]);
        expected.extend_from_slice(&[0u8; 31]);
        expected.push(7);
        assert_eq!(expected.len(), 72);
        assert_eq!(
            derive_channel_id(a, b, U256::from(7)),
            format_channel_id(keccak256(expected))
        );
    }

    #[test]
    fn a_derived_id_round_trips_through_the_string_form() {
        let id = derive_channel_id(address(0x11), address(0x22), U256::from(3));
        assert_eq!(format_channel_id(parse_channel_id(&id).expect("parse")), id);
    }
}
