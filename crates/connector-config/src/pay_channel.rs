//! `[[pay_channels]]` (ADR 0042, item 2; issue #881): the channel this node
//! **pays a next hop from, as an ordinary client of that hop**.
//!
//! # Why this is a third table and not a row in either of the other two
//!
//! A node already names channels in two places, and this is neither of
//! them:
//!
//! | table | direction | who is the authority on the watermark |
//! | --- | --- | --- |
//! | `[[client_channels]]` | claims this node **receives** at its client edge | this node |
//! | `[[peer_channels]]` | a peering's claims, both directions, judged against `ClaimBook` | this node |
//! | **`[[pay_channels]]`** | claims this node **signs and hands to a next hop** | **the next hop** |
//!
//! [ADR 0030](../../../docs/adr/0030-an-operator-announces-a-node-the-node-still-does-not.md)
//! already made this exact distinction for `[announce] pay_channel`, which
//! is the one-shot form of the same thing: *"that table is channels this
//! node receives on, and this is one it pays from. One channel in two roles
//! is the same collision `Config::load` already refuses between the peer and
//! client books."* [`ConfigError::PayChannelIsAlsoAClientChannel`] refuses
//! it here, by name, for the same reason.
//!
//! It is deliberately **not** refused against `[[peer_channels]]`. Holding
//! both roles on one channel with one hop is the deployed shape -- the peer
//! role for what arrives, the client role for what this node sends -- and
//! `connector_runtime`'s own `forward_via_peer_route` is built for it: a
//! covered packet is not owed a second time on the peer ledger, so exactly
//! one book signs per packet.
//!
//! # Where each part of the claim comes from
//!
//! ADR 0030's table is normative and this row is written to it. Only the
//! facts nothing can derive are configured:
//!
//! * the **signing key** is `[settlement.evm]`'s -- the channel's on-chain
//!   participant *is* this node's settlement address, and no second key is
//!   introduced. A row with no `[settlement.evm]` table to sign under is
//!   [`ConfigError::PayChannelWithoutEvmSettlement`] at load;
//! * the **nonce and cumulative amount** come from the receiver, asked over
//!   `POST /ilp/claim-state` (issue #693) on every packet -- never
//!   remembered, never guessed. That is what `client_edge_url` is for;
//! * the **channel id** is configured, because neither side can derive it;
//! * the **EIP-712 domain** (`chain_id`/`token_network`) is configured too,
//!   and this is the one place this table departs from the announce path.
//!   An announce reads the domain off the target's own greeting because it
//!   has one in hand; the forwarding path covers a packet *before* any
//!   greeting exists to read (that is the whole of issue #881). The domain
//!   is not a second source of truth: it is the same chain id and
//!   `TokenNetwork` the channel's peer-role domain carries, since both roles
//!   sign against the very same on-chain channel.

use std::collections::HashSet;

use serde::Deserialize;
use url::Url;

use crate::client_channel::{parse_evm_address, parse_hex_bytes, to_hex};
use crate::error::ConfigError;

/// A `[[pay_channels]]` entry as written in the config file.
///
/// EVM-shaped with no `#[serde(untagged)]` Solana twin, unlike
/// `[[peer_channels]]` and `[[client_channels]]`: an outbound client claim
/// is an EIP-712 balance proof and `connector_runtime`'s outbound client
/// ledger signs nothing else, so a Solana pay-from channel has nothing to
/// wire and is better refused as an unknown field than accepted and
/// silently inert.
///
/// `deny_unknown_fields` for the reason every money-shaped table here has
/// it: a dropped `token_network` would be a claim signed under a domain
/// nobody wrote, which recovers to a different address and is refused at
/// the far gate with the packet already paid for.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawPayChannel {
    peer_id: String,
    channel_id: String,
    chain_id: u64,
    token_network: String,
    client_edge_url: String,
}

/// A fully validated `[[pay_channels]]` entry. Constructed only by
/// [`resolve_pay_channels`] (plus [`Config::load`]'s own cross-table
/// checks), so a value that exists names a configured peering exactly once,
/// carries a well-formed on-chain channel id and `TokenNetwork` address, and
/// a `client_edge_url` this node is allowed to dial.
///
/// [`Config::load`]: crate::Config::load
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayChannelConfig {
    peer_id: String,
    channel_id: String,
    chain_id: u64,
    token_network: [u8; 20],
    client_edge_url: Url,
}

impl PayChannelConfig {
    /// The next hop this channel pays -- a `[[peers]]` entry's `id`. A row
    /// naming an id no `[[peers]]` entry configures is
    /// [`ConfigError::PayChannelOrphaned`].
    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    /// The channel this node's settlement address holds with that hop,
    /// canonicalized to lowercase `0x`-prefixed hex however the operator
    /// wrote it -- the value the covering claim names the channel by.
    ///
    /// It may not also appear in `[[client_channels]]`
    /// ([`ConfigError::PayChannelIsAlsoAClientChannel`]): that table is
    /// channels this node *receives* on, and this is one it *pays* from.
    pub fn channel_id(&self) -> &str {
        &self.channel_id
    }

    /// The chain the channel is deployed on: half of the EIP-712 domain the
    /// covering claim is signed under.
    pub fn chain_id(&self) -> u64 {
        self.chain_id
    }

    /// The `TokenNetwork` that verifies this channel's claims on
    /// redemption -- the EIP-712 `verifyingContract`, and the other half of
    /// the domain.
    pub fn token_network(&self) -> [u8; 20] {
        self.token_network
    }

    /// The next hop's own client edge: its `POST /ilp` endpoint, the URL an
    /// ordinary buyer posts a packet to. `POST /ilp/claim-state` hangs off
    /// it, and that is what this node asks -- on every covered packet -- for
    /// where its claims on this channel stand.
    ///
    /// **Explicit, never derived.** A peering's own `endpoint` is not it: on
    /// a `wss://` peering there is no HTTP URL there at all, and turning one
    /// into the other by swapping scheme and appending a path is exactly the
    /// class of guess ADR 0030 refuses for `btpEndpoint` -- right on this
    /// fleet, wrong for anyone whose deployment does not mirror it.
    pub fn client_edge_url(&self) -> &Url {
        &self.client_edge_url
    }
}

/// Validate every `[[pay_channels]]` entry.
///
/// `allow_plaintext` is the same top-level `peer_allow_plaintext_endpoints`
/// opt-in `[[peers]]` endpoints take (issue #678, gap 3), and for the same
/// reason: an `http://` claim-state ask carries a signed EIP-712 challenge
/// -- a capability to read a channel's state -- in the clear. `false` is the
/// default and every production config, and then `https://` is the only
/// scheme this table accepts.
///
/// Cross-table checks (the peering exists, the channel is not also a
/// `[[client_channels]]` row, there is a `[settlement.evm]` key to sign
/// with) live in [`Config::load`], which is the only place that has the
/// other tables in scope.
///
/// [`Config::load`]: crate::Config::load
pub(crate) fn resolve_pay_channels(
    raw: Vec<RawPayChannel>,
    allow_plaintext: bool,
) -> Result<Vec<PayChannelConfig>, ConfigError> {
    let mut seen_peers = HashSet::with_capacity(raw.len());
    let mut seen_channels = HashSet::with_capacity(raw.len());
    let mut channels = Vec::with_capacity(raw.len());

    for entry in raw {
        // One nonce line per next hop (see `connector_runtime`'s
        // `outbound_client` header: the ledger is keyed by next-hop peer
        // id, precisely so one hop reached over several routes stays one
        // line). Two rows for one hop would be two channels for one line,
        // and which one signed would depend on file order.
        if !seen_peers.insert(entry.peer_id.clone()) {
            return Err(ConfigError::PayChannelDuplicatePeer {
                peer_id: entry.peer_id,
            });
        }
        let channel_id = parse_hex_bytes::<32>(&entry.channel_id).ok_or_else(|| {
            ConfigError::PayChannelInvalidId {
                peer_id: entry.peer_id.clone(),
                value: entry.channel_id.clone(),
            }
        })?;
        let channel_id = to_hex(&channel_id);
        // The mirror image of the rule above: one channel paid from by two
        // hops is one channel carrying two nonce lines, which forks it at
        // the far gate exactly as a second process would.
        if !seen_channels.insert(channel_id.clone()) {
            return Err(ConfigError::PayChannelDuplicate { value: channel_id });
        }
        let token_network = parse_evm_address(&entry.token_network).ok_or_else(|| {
            ConfigError::PayChannelInvalidAddress {
                peer_id: entry.peer_id.clone(),
                field: "token_network",
                value: entry.token_network.clone(),
            }
        })?;
        let client_edge_url = Url::parse(&entry.client_edge_url).map_err(|source| {
            ConfigError::PayChannelInvalidClientEdgeUrl {
                peer_id: entry.peer_id.clone(),
                value: entry.client_edge_url.clone(),
                source,
            }
        })?;
        let scheme_allowed = match client_edge_url.scheme() {
            "https" => true,
            "http" => allow_plaintext,
            _ => false,
        };
        if !scheme_allowed {
            return Err(ConfigError::PayChannelClientEdgeUrlScheme {
                peer_id: entry.peer_id,
                value: entry.client_edge_url,
                scheme: client_edge_url.scheme().to_string(),
            });
        }

        channels.push(PayChannelConfig {
            peer_id: entry.peer_id,
            channel_id,
            chain_id: entry.chain_id,
            token_network,
            client_edge_url,
        });
    }

    Ok(channels)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHANNEL: &str = "0xaaaabbbbccccddddeeeeffff00001111aaaabbbbccccddddeeeeffff00001111";
    const OTHER_CHANNEL: &str =
        "0x1111222233334444555566667777888811112222333344445555666677778888";
    const NETWORK: &str = "0x3333333333333333333333333333333333333333";

    fn raw(peer_id: &str, channel_id: &str) -> RawPayChannel {
        RawPayChannel {
            peer_id: peer_id.to_string(),
            channel_id: channel_id.to_string(),
            chain_id: 8453,
            token_network: NETWORK.to_string(),
            client_edge_url: "https://relay.example/ilp".to_string(),
        }
    }

    /// The round trip: what an operator wrote comes back canonicalized,
    /// with the channel id in the one spelling a claim names it by (a
    /// channel named in two casings is two watermarks at the far gate).
    #[test]
    fn resolves_and_canonicalizes_a_row() {
        let channels = resolve_pay_channels(
            vec![raw("relay", &CHANNEL.to_uppercase().replace("0X", "0x"))],
            false,
        )
        .expect("resolve");

        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].peer_id(), "relay");
        assert_eq!(channels[0].channel_id(), CHANNEL);
        assert_eq!(channels[0].chain_id(), 8453);
        assert_eq!(channels[0].token_network(), [0x33u8; 20]);
        assert_eq!(
            channels[0].client_edge_url().as_str(),
            "https://relay.example/ilp"
        );
    }

    #[test]
    fn rejects_a_malformed_channel_id() {
        let result = resolve_pay_channels(vec![raw("relay", "0xnope")], false);

        assert!(matches!(
            result,
            Err(ConfigError::PayChannelInvalidId { ref peer_id, ref value })
                if peer_id == "relay" && value == "0xnope"
        ));
    }

    #[test]
    fn rejects_a_malformed_token_network() {
        let mut entry = raw("relay", CHANNEL);
        entry.token_network = "0x12".to_string();

        assert!(matches!(
            resolve_pay_channels(vec![entry], false),
            Err(ConfigError::PayChannelInvalidAddress {
                field: "token_network",
                ..
            })
        ));
    }

    /// One next hop, one nonce line: a second row for the same peering
    /// would be a second channel for one line, resolved by file order.
    #[test]
    fn two_rows_for_one_peering_are_refused_by_name() {
        let result = resolve_pay_channels(
            vec![raw("relay", CHANNEL), raw("relay", OTHER_CHANNEL)],
            false,
        );

        assert!(matches!(
            result,
            Err(ConfigError::PayChannelDuplicatePeer { ref peer_id }) if peer_id == "relay"
        ));
    }

    /// And the mirror: one channel paid from by two hops is one channel
    /// carrying two nonce lines.
    #[test]
    fn one_channel_paid_from_by_two_peerings_is_refused_by_name() {
        let result =
            resolve_pay_channels(vec![raw("relay", CHANNEL), raw("store", CHANNEL)], false);

        assert!(matches!(
            result,
            Err(ConfigError::PayChannelDuplicate { ref value }) if value == CHANNEL
        ));
    }

    /// A signed claim-state challenge is a capability to read a channel's
    /// state, so the ask is TLS-only unless the same loopback opt-in
    /// `[[peers]].endpoint` takes is set.
    #[test]
    fn a_plaintext_client_edge_url_is_refused_unless_plaintext_is_allowed() {
        let mut entry = raw("relay", CHANNEL);
        entry.client_edge_url = "http://127.0.0.1:3000/ilp".to_string();

        assert!(matches!(
            resolve_pay_channels(vec![entry], false),
            Err(ConfigError::PayChannelClientEdgeUrlScheme { ref scheme, .. }) if scheme == "http"
        ));

        let mut entry = raw("relay", CHANNEL);
        entry.client_edge_url = "http://127.0.0.1:3000/ilp".to_string();
        let channels = resolve_pay_channels(vec![entry], true).expect("plaintext is opted into");
        assert_eq!(channels[0].client_edge_url().scheme(), "http");
    }

    /// Neither a `wss://` peer endpoint nor a bare host is a client edge to
    /// post a packet to, and neither is silently coerced into one.
    #[test]
    fn a_client_edge_url_that_is_not_http_is_refused_by_name() {
        for written in ["wss://relay.example/btp", "relay.example/ilp"] {
            let mut entry = raw("relay", CHANNEL);
            entry.client_edge_url = written.to_string();

            let result = resolve_pay_channels(vec![entry], true);
            assert!(
                matches!(
                    result,
                    Err(ConfigError::PayChannelClientEdgeUrlScheme { .. })
                        | Err(ConfigError::PayChannelInvalidClientEdgeUrl { .. })
                ),
                "{written} should be refused"
            );
        }
    }

    /// The TOML shape itself, not just the constructor: `deny_unknown_fields`
    /// means a mistyped field is a load failure rather than a claim signed
    /// under a domain nobody wrote.
    #[test]
    fn toml_refuses_an_unknown_field() {
        let text = format!(
            r#"
peer_id = "relay"
channel_id = "{CHANNEL}"
chain_id = 8453
token_network = "{NETWORK}"
client_edge_url = "https://relay.example/ilp"
token_netwrok = "{NETWORK}"
"#
        );

        let error = toml::from_str::<RawPayChannel>(&text).expect_err("unknown field");
        assert!(error.to_string().contains("unknown field"), "{error}");
    }
}
