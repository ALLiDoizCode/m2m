//! Establishing a peering from a URL: ADR 0058's one operator write.
//!
//! ```text
//! POST /peers { id, url, fee, max_packet_amount }
//! ```
//!
//! The node reads the counterparty's self-description (ADR 0050), derives
//! the payment channel from the two settlement addresses (ADR 0059), opens
//! it on chain if it is absent, and writes a durable runtime peering --
//! with no restart and no edit to the config file. Onboarding stops being
//! "boot with no peering, open a channel, stop, hand-edit four TOML tables,
//! restart".
//!
//! # Where each part of a peering comes from
//!
//! | fact | source |
//! | --- | --- |
//! | endpoint | the self-description |
//! | carriage | the endpoint's **scheme**, and nothing else |
//! | edge identity | the self-description |
//! | settlement address, chain facts | the self-description |
//! | the channel | **derived** from the two settlement addresses |
//! | `id` | **the operator.** A label in their own namespace |
//! | `fee`, `max_packet_amount` | **the operator.** Policy, not facts |
//!
//! `id` is never derived from the peer's ILP address -- that is
//! self-asserted, a claim and not a grant (`CONTEXT.md`, **ILP address**),
//! so deriving from it would let a stranger choose what this node's route
//! table is keyed on and what its logs say. Nor from the URL host, which
//! has a milder form of the same problem and breaks when they move hosts.
//!
//! # Three identities, and they are not interchangeable
//!
//! The **edge identity** is a secp256k1 key: what a payload is sealed to
//! (ADR 0018). The **EVM settlement address** is 20 bytes. The **Solana
//! settlement address** is a base58 ed25519 public key. A channel is
//! derived from the settlement address *of the chain in question*, never
//! from the edge identity -- `TokenNetwork` recovers a balance proof's
//! signer and requires it to **be** a channel participant, so a channel
//! derived from an edge key names a participant no chain holds and the
//! claims on it are unredeemable.
//!
//! # Trust-on-first-use
//!
//! Whatever the URL serves is who the peering is with. The fetched identity
//! is not checked against anything the operator supplied; ADR 0058
//! considered a `settlement_address` pin and rejected it, because an
//! operator who copies the address out of the same document they are
//! pointing the node at has pinned nothing, and a pin that is usually
//! theatre invites the belief that a peering's identity is
//! cryptographically bound when it is not. A party who controls the URL's
//! DNS or a certificate for it chooses the counterparty, and under ADR 0059
//! that choice determines the channel address -- so it is a party you would
//! fund. The operator's vetting of the URL is the whole of the assurance.
//!
//! What that does **not** weaken: every value-bearing check downstream is
//! unchanged and remains cryptographic. A claim's signature is verified
//! against the counterparty key recorded for the channel and never against
//! anything the claim declares about itself, and a payload is sealed to the
//! edge identity. A wrong document produces a peering that does not work;
//! it does not produce one that silently misroutes value to a third party
//! while appearing to work.
//!
//! # The endpoint can spend gas
//!
//! Deriving-and-opening means this may submit a transaction and wait for
//! it, so it can fail *after* money has moved. Two rules follow, and both
//! are structural rather than matters of care:
//!
//! * the durable row is written from a **confirmed** channel -- the id
//!   comes back off the chain, never off the submitted transaction;
//! * repeating the request against a peering already established is a
//!   **success, not a second channel**, because ADR 0059's derivation lands
//!   on the same identifier from the same two participants.
//!
//! And the answer says which branch it took ([`ChannelBranch`]), so an
//! unintended second channel is visible in the operator's own output rather
//! than discovered later on a block explorer.

use chrono::Duration;
use connector_config::{SettlementChain, DEFAULT_MAX_PACKET_AMOUNT};
use connector_domain::x402::{
    X402ChainSettlementTerms, X402SettlementTerms, X402SolanaSettlementTerms,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

use crate::connector::{ChannelOperationError, Connector, PeerRouteTableError};
use crate::operator_view::PeerView;
use crate::peer_route_store::{RuntimePeerChannel, RuntimePeering};
use crate::self_description::SelfDescriptionError;

/// The withdrawal-safety window a channel opened by establishing a peering
/// gets.
///
/// A day, which is comfortably past `TokenNetwork`'s own one-hour
/// `MIN_SETTLEMENT_TIMEOUT` and is a window an operator can act inside
/// without watching a clock. It is not configurable on this write and does
/// not need to be: an operator who wants a different one opens the channel
/// explicitly with `POST /channels` first, and this write then **finds**
/// that channel rather than opening a second (ADR 0058 keeps that endpoint
/// available for exactly this).
pub const PEERING_SETTLEMENT_TIMEOUT_SECONDS: i64 = 24 * 60 * 60;

/// Which branch the derive-or-open took.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelBranch {
    /// The pair already had a live channel, and this peering uses it. What
    /// a repeat of the same request reports.
    Found,
    /// No channel existed for the pair, so one was opened and confirmed.
    Created,
}

/// The channel a peering was established on, and how it got there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EstablishedChannel {
    /// The channel's on-chain identifier, as read back from the chain.
    pub id: String,
    pub status: ChannelBranch,
    /// Which chain it lives on -- `"evm"` or `"solana"`.
    pub chain: String,
}

/// What `POST /peers` answers: the peering, and the channel branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeeringEstablished {
    #[serde(flatten)]
    pub peer: PeerView,
    pub channel: EstablishedChannel,
}

/// Why a peering could not be established.
#[derive(Debug, Error)]
pub enum EstablishPeeringError {
    /// The URL's document could not be read. Named separately from every
    /// refusal below because it is the one failure that is about the
    /// *counterparty's* host rather than about this node's state.
    #[error(transparent)]
    SelfDescription(#[from] SelfDescriptionError),
    /// The document named no endpoint this node can dial on a carriage it
    /// speaks, so there would be no way to reach the counterparty.
    #[error(
        "{url} publishes no endpoint this connector can dial (its schemes select no carriage)"
    )]
    NoDialableEndpoint { url: String },
    /// This node and the counterparty settle on no chain in common, so no
    /// channel can exist between them and no claim could ever be paid.
    #[error("this connector and {url} settle on no chain in common, so no channel can be derived")]
    NoSharedChain { url: String },
    /// Both nodes settle on more than one chain in common and the request
    /// named none. Refused rather than resolved silently -- the same
    /// posture `POST /channels` already takes (issue #630), and for the
    /// same reason: picking one for the operator is picking which asset a
    /// peering settles in.
    #[error(
        "this connector and {url} share settlement on {chains}; name one as `chain` in the request"
    )]
    AmbiguousChain { url: String, chains: String },
    /// The document's settlement address for the chosen chain is not an
    /// address of that chain's shape. Never coerced into one: a channel
    /// derived from the wrong bytes names a participant no chain holds.
    #[error("{url} published a {chain} settlement address this connector cannot read: {value}")]
    UnreadableSettlementAddress {
        url: String,
        chain: String,
        value: String,
    },
    /// The chain operation itself failed -- reading whether a channel
    /// exists, or opening one.
    #[error(transparent)]
    Channel(#[from] ChannelOperationError),
    /// The durable write was refused. Carries ADR 0034's precedence rules
    /// through unchanged.
    #[error(transparent)]
    Table(#[from] PeerRouteTableError),
}

impl Connector {
    /// Establish a peering with whoever answers `url`: ADR 0058's whole
    /// operator write.
    ///
    /// Refuses **before any outbound request** on anything about this
    /// node's own state that would make the write unlandable -- an empty
    /// id, or one the config file owns (ADR 0034). A peering that could
    /// never be written is not worth a stranger's host being dialled for.
    ///
    /// `chain` is an optional disambiguator for the one case that has no
    /// honest default: two nodes that settle on more than one chain in
    /// common. Left out, a single shared chain is used and several are
    /// [`EstablishPeeringError::AmbiguousChain`].
    pub async fn establish_peering(
        &self,
        id: impl Into<String>,
        url: &Url,
        fee: u64,
        max_packet_amount: u64,
        chain: Option<SettlementChain>,
    ) -> Result<PeeringEstablished, EstablishPeeringError> {
        let id = id.into();
        self.refuse_unlandable_peering(&id)?;

        let document = self.self_description_source().fetch(url).await?;

        let endpoint = peer_endpoint(&document, self.peer_allows_plaintext()).ok_or_else(|| {
            EstablishPeeringError::NoDialableEndpoint {
                url: url.to_string(),
            }
        })?;

        let terms = self.shared_settlement(&document, chain, url)?;
        let counterparty = counterparty_bytes(&terms, url)?;

        let settlement = self.settlement_on_chain(terms.chain())?;
        let (channel_id, branch) = match settlement.live_channel_with(counterparty.clone()).await {
            Ok(Some(existing)) => (existing.0, ChannelBranch::Found),
            Ok(None) => {
                // The id comes back off the chain, not off the submitted
                // transaction: `open_channel` reads the channel's state
                // after opening it, so a row written here is a row backed
                // by a channel a chain confirmed.
                let opened = self
                    .open_channel(
                        Some(terms.chain()),
                        counterparty.clone(),
                        Duration::seconds(PEERING_SETTLEMENT_TIMEOUT_SECONDS),
                    )
                    .await?;
                (opened.id, ChannelBranch::Created)
            }
            Err(error) => return Err(ChannelOperationError::Settlement(error).into()),
        };

        let binding = terms.binding(channel_id.clone());
        let peering = RuntimePeering {
            fee,
            max_packet_amount,
            endpoint: Some(endpoint.to_string()),
            edge_identity: document
                .edge_identity
                .as_ref()
                .map(|identity| identity.public_key.clone()),
            client_edge_url: document.http_endpoint.clone(),
            channels: vec![binding.clone()],
        };

        // Bind the channel and the carriage before the durable write, so a
        // row that lands is a row this node can already act on; and write
        // the row last, so the durable table never names a peering the
        // running process has not wired up.
        self.bind_runtime_peer_channel(&id, &binding);
        self.register_runtime_peering(&id, &peering);
        let peer = self.upsert_runtime_peer(id, peering)?;

        Ok(PeeringEstablished {
            peer,
            channel: EstablishedChannel {
                id: channel_id,
                status: branch,
                chain: terms.chain().to_string(),
            },
        })
    }
}

/// The endpoint this connector dials a counterparty on, read off its
/// self-description.
///
/// **BTP first where both are published.** A dialed BTP session is
/// symmetric once established, so either side may originate on it
/// (`peer-carriage-spec.md` §2.3); an ILP-over-HTTP peering can only ever
/// be originated on by the dialer (§6.4). Preferring the carriage that
/// leaves both directions open is the choice that forecloses least, and an
/// operator who wants the other one writes the peering in the config file.
///
/// `None` when neither published endpoint's scheme selects a carriage this
/// node will dial -- a `wss://`/`https://` endpoint always does, and a
/// plaintext one only on a node that opted in.
fn peer_endpoint(
    document: &connector_domain::NodeSelfDescription,
    allow_plaintext: bool,
) -> Option<Url> {
    let dialable = |published: &Option<String>| -> Option<Url> {
        let url = Url::parse(published.as_deref()?).ok()?;
        connector_config::PeerCarriage::from_scheme_allowing_plaintext(
            url.scheme(),
            allow_plaintext,
        )
        .map(|_| url)
    };
    dialable(&document.btp_endpoint).or_else(|| dialable(&document.http_endpoint))
}

/// One chain's published settlement facts, narrowed to the chain this
/// connector also settles on.
pub(crate) enum SharedSettlement {
    Evm(X402SettlementTerms),
    Solana(X402SolanaSettlementTerms),
}

impl SharedSettlement {
    pub(crate) fn chain(&self) -> SettlementChain {
        match self {
            SharedSettlement::Evm(_) => SettlementChain::Evm,
            SharedSettlement::Solana(_) => SettlementChain::Solana,
        }
    }

    /// The counterparty's settlement address as published -- **not** its
    /// edge identity, which is a key on a different curve for a different
    /// job.
    fn settlement_address(&self) -> &str {
        match self {
            SharedSettlement::Evm(evm) => &evm.settlement_address,
            SharedSettlement::Solana(solana) => &solana.settlement_address,
        }
    }

    /// The durable binding for `channel_id`, carrying whichever domain
    /// facts this chain's claims are signed under: the EIP-712 chain id and
    /// `TokenNetwork` for EVM (ADR 0024), the settlement program for Solana
    /// (ADR 0053).
    fn binding(&self, channel_id: String) -> RuntimePeerChannel {
        match self {
            SharedSettlement::Evm(evm) => RuntimePeerChannel::Evm {
                channel_id,
                counterparty_key: evm.settlement_address.clone(),
                chain_id: evm_chain_id(&evm.chain),
                token_network: evm.token_network.clone(),
            },
            SharedSettlement::Solana(solana) => RuntimePeerChannel::Solana {
                channel_account: channel_id,
                counterparty_key: solana.settlement_address.clone(),
                program_id: solana.program_id.clone(),
            },
        }
    }
}

/// The numeric half of a published `evm:<chainId>`. Zero for a document
/// that published something else, which then produces a domain no claim
/// verifies under -- refused loudly on the first claim rather than
/// silently defaulted to a real chain's id.
fn evm_chain_id(chain: &str) -> u64 {
    chain
        .strip_prefix("evm:")
        .and_then(|digits| digits.parse().ok())
        .unwrap_or(0)
}

/// A 20-byte EVM address from its `0x`-prefixed (or bare) hex spelling.
///
/// `None` rather than a padded or truncated address for anything that is
/// not exactly 20 bytes of hex: a settlement address coerced into shape
/// names a participant no chain holds, and every claim against the channel
/// derived from it would be unredeemable.
pub(crate) fn parse_evm_address(value: &str) -> Option<[u8; 20]> {
    let hex = value.strip_prefix("0x").unwrap_or(value);
    if hex.len() != 40 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut address = [0u8; 20];
    for (i, byte) in address.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(address)
}

/// The counterparty's settlement address for `terms`, in the byte form
/// that chain's [`connector_settlement::SettlementBackend`] takes: 20 bytes
/// for EVM, a 32-byte ed25519 public key for Solana.
fn counterparty_bytes(
    terms: &SharedSettlement,
    url: &Url,
) -> Result<Vec<u8>, EstablishPeeringError> {
    let value = terms.settlement_address();
    let unreadable = || EstablishPeeringError::UnreadableSettlementAddress {
        url: url.to_string(),
        chain: terms.chain().to_string(),
        value: value.to_string(),
    };
    match terms {
        SharedSettlement::Evm(_) => parse_evm_address(value)
            .map(|address| address.to_vec())
            .ok_or_else(unreadable),
        SharedSettlement::Solana(_) => {
            let bytes = bs58::decode(value).into_vec().map_err(|_| unreadable())?;
            if bytes.len() != 32 {
                return Err(unreadable());
            }
            Ok(bytes)
        }
    }
}

/// Narrow a document's published settlements to the one chain this
/// connector will derive a channel on.
pub(crate) fn shared_settlement_of(
    document: &connector_domain::NodeSelfDescription,
    settles_on: impl Fn(SettlementChain) -> bool,
    wanted: Option<SettlementChain>,
    url: &Url,
) -> Result<SharedSettlement, EstablishPeeringError> {
    let mut shared: Vec<SharedSettlement> = document
        .settlements
        .iter()
        .map(|entry| match entry {
            X402ChainSettlementTerms::Evm(evm) => SharedSettlement::Evm(evm.clone()),
            X402ChainSettlementTerms::Solana(solana) => SharedSettlement::Solana(solana.clone()),
        })
        .filter(|entry| settles_on(entry.chain()))
        .collect();
    if let Some(wanted) = wanted {
        shared.retain(|entry| entry.chain() == wanted);
    }
    match shared.len() {
        0 => Err(EstablishPeeringError::NoSharedChain {
            url: url.to_string(),
        }),
        1 => Ok(shared.remove(0)),
        _ => {
            let chains: Vec<String> = shared
                .iter()
                .map(|entry| entry.chain().to_string())
                .collect();
            Err(EstablishPeeringError::AmbiguousChain {
                url: url.to_string(),
                chains: chains.join(", "),
            })
        }
    }
}

/// The cap a peering row states, or the standing bound when it states
/// none. Shared with [`Connector`]'s own reader so the number reported to
/// an operator and the number enforced on a packet are one rule.
pub(crate) fn stated_cap(max_packet_amount: u64) -> u64 {
    if max_packet_amount > 0 {
        max_packet_amount
    } else {
        DEFAULT_MAX_PACKET_AMOUNT
    }
}
