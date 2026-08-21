//! `connector announce <relay-discovery-url>` (issue #784): an operator
//! announces a node **from that node**, paying like any other client, with
//! the identity key never leaving the box.
//!
//! # Why this is a subcommand and not a sidecar
//!
//! A kind:10032 announce is a paid write like any other, and the node being
//! announced is the only party that can make it honestly: it holds the
//! identity key the event is signed with, it holds the settlement facts the
//! announce advertises, and it holds a channel with somebody who can carry
//! the packet. `packages/announcer` is a separate process, so it holds none
//! of those -- which is why the cutover runbook's stopgap proposes moving a
//! **key** to where a free relay is. This moves the **write** to where the
//! key is instead.
//!
//! # Why this is not the operator surface
//!
//! `POST /packets` already does exactly the hard part of this -- "an
//! operator originates a packet outward, exactly as the client edge does for
//! an external caller" -- and issue #753 established that enabling
//! `[operator]` to expose one endpoint publishes the whole write surface,
//! because the bearer `route_layer` wraps reads only and the Rust operator
//! paths carry no `/admin` prefix for nginx to deny. A subcommand calls the
//! same `Connector::handle_prepare` **in-process**: no operator section, no
//! bearer token, no write keys, no second HTTP surface. That is not an
//! incidental saving; it is the reason this shape was chosen.
//!
//! # The three URLs, and the fourth fact
//!
//! | | what it is | where it comes from |
//! | --- | --- | --- |
//! | **through** | the edge you publish THROUGH -- its terms are what you pay | the CLI argument |
//! | **`http_endpoint`/`btp_endpoint`** | where clients PAY you | `[announce]` -- the node cannot introspect it |
//! | **`relay_url`** | where clients READ you for FREE | `[announce]`, and **optional** |
//!
//! Conflating any two is the bug, and `crates/connector-config/src/announce.rs`
//! is where each is refused for naming the wrong scheme.
//!
//! There is a **fourth** fact the issue's table does not have, and it is the
//! one place this implementation departs from #784's text. #784 says the
//! through-URL's x402 greeting carries "price, destination, chain,
//! contracts, decimals ... the whole negotiation". It carries the price and
//! the settlement facts, but **not the destination**: `payTo` is
//! `x402_terms_body`'s `destination.to_string()` -- it *echoes back*
//! whichever ILP address the probing PREPARE asked about. There is no
//! endpoint on a connector's client edge that enumerates its routes, and
//! there should not be. So the ILP address to publish to is supplied,
//! either as `--to` or as `[announce] publish_to`, and an invocation with
//! neither is refused by name rather than guessing. An operator who
//! discovered the relay from another relay's kind:10032 already has it: it
//! is that announce's own `routes.publish`.
//!
//! # What a green run proves, and the traps behind it
//!
//! Every one of these cost a working afternoon when the paid write was
//! first done by hand, and each is invisible from a passing run. They are
//! also each written down in `crates/connector-bin/tests/devnet_store_leg_probe.rs`,
//! which is the closest working reference to this file:
//!
//!   * **Seal to the TERMINATING connector, never a forwarding hop** (ADR
//!     0018). The wrap is opened by the node that terminates the route; a
//!     hop carries it as opaque bytes. That is why the identity is fetched
//!     from the through-URL rather than taken from this node's own signer:
//!     the through-URL is by definition the edge that fronts the chosen
//!     relay.
//!   * **The execution condition is not free** (ADR 0019). It is
//!     `sha256(HKDF-SHA256(shared_secret, salt=zeros(32),
//!     info="toon-giftwrap-fulfillment", 32))`, derived here through the
//!     workspace's own signer so there is no second implementation to
//!     drift.
//!   * **The PREPARE encoding is not stock ILPv4** -- a `VarUInt` amount and
//!     a 19-byte ASN.1 `GeneralizedTime` expiry, with no outer length
//!     prefix. Nothing here re-derives it: `Prepare::encode` from
//!     `connector-domain` is the same code the connector parses with.
//!   * **The price arithmetic is a subtraction** (ADR 0028, #754). This hop
//!     forwards `amount - fee` and the terminating side charges its own
//!     price on ARRIVAL, so the amount must cover both -- see
//!     [`amount_to_pay`].

use std::collections::BTreeMap;
use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{Duration as ChronoDuration, Utc};
use connector_config::{AnnounceConfig, Config, SecretLocation, SettlementConfig, TransportPolicy};
use connector_domain::{
    derive_condition, EnvelopeRequest, EnvelopeResponse, Fulfill, PacketResponse, Prepare, Reject,
};
// The outbound client ledger (issue #873): the receiver-authoritative
// watermark, the nonce line and the claim signing this path used to carry
// itself, now shared with the forwarding path.
use connector_runtime::{EvmDomain, HttpClaimState, OutboundClientError, OutboundClientLedger};
use connector_signer::giftwrap::{derive_fulfillment, open_response, seal_request};
use connector_signer::{sign_ilp_peer_info, LocalSigner, NostrEvent, PublicKeyBytes};
use serde::Serialize;

use crate::runtime::{
    read_announce_identity_secret, read_settlement_key_bytes, read_signer_secret, Runtime,
    RuntimeError,
};

/// How long the free, unauthenticated negotiation calls may take. Short on
/// purpose: they are two small reads against one host, and an operator
/// running this by hand should get an error rather than a hang.
const NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(15);

/// How long the announce PREPARE stays valid. Generous, because it may
/// cross a peering and a relay write before it can be answered -- the same
/// reasoning `devnet_store_leg_probe.rs` gives for its own two minutes.
const PREPARE_TTL_MINUTES: i64 = 2;

/// Everything `connector announce` needs beyond the config file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnnounceOptions {
    /// The edge to publish THROUGH -- e.g. `https://relay-op.example/ilp`.
    /// Its x402 greeting carries the terms, and its `/ilp/identity` is the
    /// key the gift wrap is sealed to.
    pub through_url: String,
    /// The ILP address to publish to, overriding `[announce] publish_to`.
    pub publish_to: Option<String>,
    /// The envelope `target` the relay's write ingress sits at BENEATH the
    /// route's own `handler_url`. `None` means `""`, "the route's own
    /// handler path" -- correct whenever the route's `handler_url` already
    /// ends at the ingress, which is how every relay route on this fleet is
    /// written (`http://relay:3100/write`).
    pub target: Option<String>,
    /// The target's **BTP** endpoint, for a route whose policy requires that
    /// carriage (issue #701). Overrides `[announce] publish_btp_url`.
    ///
    /// Explicit input, never derived. Before issue #807 the x402 greeting
    /// carried no BTP URL at all -- verified against the live devnet apex,
    /// whose `extra` keys were exactly `endpoint` (the HTTP one),
    /// `ilpAddress`, `price`, `requiredTransport`, `sessionLeaseTtlMs`,
    /// `settlement` and `settlements`. #807 added `extra.btpEndpoint`, but
    /// only for a target that configures its own `[announce]`; a target
    /// that does not still leaves nothing to negotiate from, which is why
    /// this stays input rather than something this command reads back.
    /// Deriving it from the HTTP URL by swapping the scheme and appending
    /// `/btp` is the same class of guess `relay_url` and `payTo` have
    /// already punished: it would be right on this fleet and wrong for any
    /// operator whose deployment does not mirror it. An operator who needs
    /// this finds it in the target's own x402 greeting
    /// (`extra.btpEndpoint`, issue #807) or its kind:10032 announce, both
    /// spelled `btpEndpoint`.
    pub btp_url: Option<String>,
    /// Send the packet through **this node's own routing table** instead of
    /// paying the through-URL directly.
    ///
    /// Off by default, and the default is the point. An announce is "an
    /// operator announces to a relay whose URL they provide, **paying like
    /// any other client**" -- so the paid PREPARE goes TO that URL, over
    /// its own connection, with a claim in the header. Nothing about the
    /// announcing node's routing table enters into it: no `[[routes]]`
    /// entry reaching the relay, no peering to originate over.
    ///
    /// The opt-in exists because originating through one's own routing is
    /// a coherent thing to want -- it is what `POST /packets` does, and it
    /// lets an operator pay over an existing peering rather than opening a
    /// client channel. It is not the default because it makes the URL
    /// argument mean two different things at once: "who I pay" and "who I
    /// ask", with delivery quietly depending on the local routing table
    /// happening to reach the second.
    pub via_own_routing: bool,
    /// Build and print the announce without paying for it or sending it.
    pub dry_run: bool,
}

/// Everything that can stop an announce, each named for what an operator
/// has to change. Deliberately not folded into [`RuntimeError`]: these are
/// failures of a one-shot operator action against somebody else's node,
/// not of constructing this one.
#[derive(Debug)]
pub enum AnnounceError {
    /// The config file has no `[announce]` section, so this node has
    /// nothing to say about itself that it could not have made up.
    NoAnnounceSection,
    /// Neither `--to` nor `[announce] publish_to` named an ILP address.
    NoDestination,
    /// A connector is already serving this config's client edge, and this
    /// process would be a second writer on the same claim journals.
    AlreadyServing { addr: SocketAddr },
    /// The through-URL is not a URL, or names no host.
    InvalidThroughUrl { value: String, reason: String },
    /// A free negotiation call against the through-URL failed.
    Negotiation { url: String, reason: String },
    /// The through-URL answered the unpaid PREPARE with something other
    /// than x402 terms -- typically because it serves no route for the
    /// destination, or is not a connector client edge at all.
    NoTerms {
        url: String,
        status: u16,
        body: String,
    },
    /// The runtime this node's own config describes could not be built.
    Runtime(RuntimeError),
    /// The identity key is held somewhere this process cannot read the
    /// scalar from, so no BIP-340 signature over the announce is possible.
    UnsignableIdentity,
    /// The announce event could not be signed.
    Signing(String),
    /// The gift wrap could not be sealed to the through-URL's identity.
    Seal(String),
    /// The packet was originated and came home a REJECT.
    Rejected {
        code: String,
        triggered_by: String,
        message: String,
    },
    /// The packet FULFILLed but the sealed answer could not be read, or the
    /// relay refused the event it carried.
    RelayRefused { status: u16, body: String },
    /// No `[announce] pay_channel`, so there is no channel to pay the
    /// through-URL from as a client.
    NoPayChannel,
    /// No `[settlement.evm]` table, so there is no on-chain identity to
    /// sign a client claim with.
    NoSettlementIdentity,
    /// The through-URL's greeting carries no EVM settlement terms, so the
    /// EIP-712 domain its claim gate verifies under is unknown.
    NoSettlementTerms { url: String },
    /// The through-URL would not tell this node its own watermark on the
    /// channel it is about to claim against.
    ClaimStateUnavailable { channel: String, reason: String },
    /// The channel has less spendable headroom than the announce costs, so
    /// a claim would be refused on arrival -- said here rather than bought.
    InsufficientHeadroom {
        channel: String,
        available: u128,
        amount: u64,
    },
    /// The paid POST reached the through-URL but the answer was neither a
    /// FULFILL nor a REJECT.
    UnreadableAnswer { status: u16, body: String },
    /// The target's route requires BTP and no BTP endpoint was supplied.
    NoBtpEndpoint {
        destination: String,
        through_url: String,
    },
    /// The target's route requires a transport this command cannot speak.
    WrongTransport {
        destination: String,
        required: String,
    },
    /// The BTP session itself failed.
    Btp { url: String, reason: String },
}

impl fmt::Display for AnnounceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AnnounceError::NoAnnounceSection => write!(
                f,
                "this config has no [announce] section, so there is nothing to announce that \
                 this node could know: its own public endpoints and the addresses an announce \
                 covers are operator facts a node behind TLS termination cannot introspect. \
                 See docs/operators/announcing-a-node.md (issue #784)"
            ),
            AnnounceError::NoDestination => write!(
                f,
                "no ILP address to publish to: pass `--to <address>` or set \
                 `[announce] publish_to`. This is NOT discoverable from the through-URL -- the \
                 x402 greeting's `payTo` echoes back whichever destination the asking PREPARE \
                 named, so a greeting can confirm a destination but never supply one. If you \
                 found the relay in another node's kind:10032 announce, the address you want is \
                 that announce's own `routes.publish`"
            ),
            AnnounceError::AlreadyServing { addr } => write!(
                f,
                "a connector is already serving this config's client edge at {addr}, and this \
                 announce FORWARDS over a peering -- so it would sign an outbound claim from a \
                 SECOND process sharing that node's `state_dir`. Both replay the same journal, \
                 both sign the next nonce against different cumulative amounts, and the far side \
                 refuses one of them as a replay -- after which the serving node's claims never \
                 advance the far side's watermark again and the peering silently stops being \
                 paid. Stop the node, announce, and start it again; or use `--dry-run`, which \
                 signs nothing for the wire and sends nothing. (An announce to a route this node \
                 TERMINATES signs no claim and is not blocked.) See issue #784"
            ),
            AnnounceError::InvalidThroughUrl { value, reason } => write!(
                f,
                "'{value}' is not a usable through-URL: {reason}. It must be the FULL client-edge \
                 ILP endpoint of the connector fronting the relay you want to be discovered on, \
                 e.g. https://relay-op.example/ilp"
            ),
            AnnounceError::Negotiation { url, reason } => write!(
                f,
                "the free, unauthenticated negotiation against {url} failed: {reason}"
            ),
            AnnounceError::NoTerms { url, status, body } => write!(
                f,
                "{url} answered an unpaid PREPARE with HTTP {status} instead of 402 x402 terms, \
                 so there is nothing to pay: {body}. The usual cause is that this edge serves no \
                 route for the destination you asked about"
            ),
            AnnounceError::Runtime(source) => write!(f, "{source}"),
            AnnounceError::UnsignableIdentity => write!(
                f,
                "the [signer] identity is held in a KMS, and a Nostr announce is a BIP-340 \
                 Schnorr signature over the event's own id, which needs the scalar itself. Use \
                 `signer.key_file` on a node that announces"
            ),
            AnnounceError::Signing(reason) => write!(f, "failed to sign the announce: {reason}"),
            AnnounceError::Seal(reason) => write!(
                f,
                "failed to seal the announce to the through-URL's identity: {reason}"
            ),
            AnnounceError::Rejected {
                code,
                triggered_by,
                message,
            } => write!(
                f,
                "the announce was REJECTED {code} by '{triggered_by}': {message}. F02 means this \
                 node has no route to the destination -- an announce is paid through this node's \
                 OWN routing, so it needs a `[[routes]]` entry (and, over a peering, a channel) \
                 reaching the connector that fronts the relay. F03 means the amount did not \
                 cover what the terminating side charges on arrival. F01 means the gift wrap was \
                 sealed to the wrong node, i.e. the through-URL forwards the destination \
                 onwards rather than terminating it"
            ),
            AnnounceError::RelayRefused { status, body } => write!(
                f,
                "the packet FULFILLed -- so it WAS paid for -- but the relay's write ingress \
                 answered HTTP {status}: {body}"
            ),
            AnnounceError::NoPayChannel => write!(
                f,
                "no `[announce] pay_channel`: an announce is paid to the through-URL as an \
                 ordinary client, which needs a funded payment channel WITH that node. Open one \
                 (its `POST /channels`, or any client that opens channels) and name its 32-byte \
                 on-chain id here. Deliberately not a [[client_channels]] row -- that table is \
                 channels this node RECEIVES on. See docs/operators/announcing-a-node.md"
            ),
            AnnounceError::NoSettlementIdentity => write!(
                f,
                "no `[settlement.evm]` table: a client claim is an EIP-712 balance proof signed \
                 by the channel's on-chain participant, which is this node's SETTLEMENT address \
                 -- the same key ADR 0024's outbound peer claims use. There is no second key to \
                 configure and none is invented; a node with no EVM settlement identity cannot \
                 pay anyone"
            ),
            AnnounceError::NoSettlementTerms { url } => write!(
                f,
                "{url}'s x402 greeting carries no EVM settlement terms, so the EIP-712 domain \
                 its claim gate verifies under is unknown and any claim signed for it would \
                 recover to the wrong address. That node has no `[settlement.evm]` table, and a \
                 node with no settlement backend cannot be paid by channel claim"
            ),
            AnnounceError::ClaimStateUnavailable { channel, reason } => write!(
                f,
                "the through-URL would not report this node's claim state on channel {channel}: \
                 {reason}. The RECEIVER is the authority on its own watermark (a claim whose \
                 nonce does not advance it is refused as a replay), so this is not guessed. The \
                 usual causes are a channel that node cannot resolve on chain, or one whose \
                 counterparty is not this node's settlement address"
            ),
            AnnounceError::InsufficientHeadroom {
                channel,
                available,
                amount,
            } => write!(
                f,
                "channel {channel} has {available} base units of spendable headroom but the \
                 announce costs {amount}: a claim above what has actually been deposited could \
                 never be redeemed on chain, so the far side refuses it (issue #646). Fund the \
                 channel and try again -- nothing was sent and nothing was spent"
            ),
            AnnounceError::UnreadableAnswer { status, body } => write!(
                f,
                "the through-URL answered HTTP {status} with something that is neither a FULFILL \
                 nor a REJECT: {body}"
            ),
            AnnounceError::NoBtpEndpoint {
                destination,
                through_url,
            } => write!(
                f,
                "that node's route for '{destination}' requires the 'btp' transport (issue #701), \
                 and no BTP endpoint was given. It CANNOT be derived from {through_url}: \
                 swapping the scheme and appending a path would be a guess that happens to work \
                 only on deployments shaped like ours, and a target's x402 greeting carries \
                 `extra.btpEndpoint` only when that target configures its own `[announce]` \
                 (issue #807), which it need not. Where an operator finds it: the target node's \
                 own greeting (`extra.btpEndpoint`) or its kind:10032 announce, both spelled \
                 `btpEndpoint`. Pass it as `--btp-url wss://...`, or set \
                 `[announce] publish_btp_url`"
            ),
            AnnounceError::WrongTransport {
                destination,
                required,
            } => write!(
                f,
                "that node's route for '{destination}' requires the '{required}' transport, which \
                 this command cannot speak -- it pays over HTTP, or over BTP when given a \
                 `--btp-url`. A paid request over any other carriage is answered with the same \
                 x402 terms rather than served, however correct the claim (issue #701)"
            ),
            AnnounceError::Btp { url, reason } => {
                write!(f, "the BTP session with {url} failed: {reason}")
            }
        }
    }
}

impl std::error::Error for AnnounceError {}

impl From<RuntimeError> for AnnounceError {
    fn from(source: RuntimeError) -> Self {
        AnnounceError::Runtime(source)
    }
}

/// The outbound client ledger's failures, said in this command's own words
/// (issue #873).
///
/// Mapped rather than wrapped: an operator running `connector announce` by
/// hand gets the same sentences this command printed before the ledger
/// moved out of this file, because the sentences were the useful part.
impl From<OutboundClientError> for AnnounceError {
    fn from(source: OutboundClientError) -> Self {
        match source {
            OutboundClientError::ClaimStateUnavailable { channel, reason } => {
                AnnounceError::ClaimStateUnavailable { channel, reason }
            }
            OutboundClientError::InsufficientHeadroom {
                channel,
                available,
                amount,
            } => AnnounceError::InsufficientHeadroom {
                channel,
                available,
                amount,
            },
            OutboundClientError::Signing(reason) => AnnounceError::Signing(reason),
            // Unreachable from this command as written -- it opens the
            // ledger in memory (see `pay_the_through_url`) -- but carried
            // through rather than unwrapped, so that stays a fact about the
            // call site and not a `panic!` waiting for one to change.
            source @ OutboundClientError::LedgerUnwritable { .. } => {
                AnnounceError::Signing(source.to_string())
            }
        }
    }
}

// ── the kind:10032 content ───────────────────────────────────────────────────

/// The kind:10032 `IlpPeerInfo` payload, field-for-field the shape the
/// retired TypeScript connector published and `@toon-protocol/core`'s
/// `parseIlpPeerInfo` reads -- so rig, toon-client and every other consumer
/// needs no change. Ported from `packages/announcer/src/announce-builder.ts`
/// and `event.ts` rather than redesigned: an announce whose fields differ
/// from what a client already caches looks like a different node.
///
/// Every optional field is omitted when empty rather than emitted null, for
/// the same reason: a parser written before a field existed must be
/// unaffected by it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IlpPeerInfo {
    #[serde(rename = "ilpAddress")]
    pub ilp_address: String,
    #[serde(rename = "ilpAddresses", skip_serializing_if = "Option::is_none")]
    pub ilp_addresses: Option<Vec<String>>,
    #[serde(rename = "btpEndpoint")]
    pub btp_endpoint: String,
    #[serde(rename = "httpEndpoint")]
    pub http_endpoint: String,
    /// Present exactly when this node fronts a relay for free reads.
    #[serde(rename = "relayUrl", skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
    #[serde(rename = "assetCode")]
    pub asset_code: String,
    #[serde(rename = "assetScale")]
    pub asset_scale: u8,
    #[serde(rename = "supportedChains", skip_serializing_if = "Vec::is_empty")]
    pub supported_chains: Vec<String>,
    #[serde(
        rename = "settlementAddresses",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub settlement_addresses: BTreeMap<String, String>,
    #[serde(rename = "tokenNetworks", skip_serializing_if = "BTreeMap::is_empty")]
    pub token_networks: BTreeMap<String, String>,
    #[serde(rename = "preferredTokens", skip_serializing_if = "BTreeMap::is_empty")]
    pub preferred_tokens: BTreeMap<String, String>,
    #[serde(rename = "routePrices", skip_serializing_if = "BTreeMap::is_empty")]
    pub route_prices: BTreeMap<String, String>,
    /// The client transport the routes this announce covers REQUIRE (issue
    /// #701's `transport = "btp"`), when they agree on one that is not the
    /// permissive default. Absent whenever they do not -- which is every
    /// ordinary node, so an announce is unchanged by this field existing.
    ///
    /// The requirement was ENFORCED long before it was advertised, and that
    /// gap is the defect this field closes. The devnet relay box pins
    /// `g.toon.relay` to `transport = "btp"` (huddles' 49 fps sessions), so
    /// its client edge refuses a paid write that arrived over `POST /ilp`
    /// -- and its kind:10032 announce said nothing about it. Verified live
    /// 2026-08-14 on `connector:rust-sha-415531a`: NOT ONE announce in the
    /// fleet's corpus carried a `requiredTransport` key in any form. A
    /// stock client therefore had no way to learn the requirement except by
    /// being refused: toon-client's `terminatorRequiresBtp` guard
    /// (toon-client#558) reads exactly this key, found nothing, fell
    /// through to HTTP, and was refused on every relay publish.
    ///
    /// Two things about the shape are load-bearing and neither is
    /// negotiable from this side:
    ///
    ///   * it is **top level**, not inside an `extra` object. The x402
    ///     GREETING spells it `extra.requiredTransport` (see [`Terms`],
    ///     which parses that one), but a kind:10032 content has no `extra`
    ///     block at all, and toon-client's reader
    ///     (`packages/client/src/discovery-subscription.ts`'s
    ///     `extractRequiredTransport`) takes `JSON.parse(content)
    ///     ['requiredTransport']` off the root. Nested, it would be
    ///     invisible to the only consumer there is;
    ///   * it is **per node**, not per route, because that reader keys it
    ///     by the announcing pubkey and applies it to whichever terminator
    ///     claim wins. That is why [`announced_required_transport`] emits
    ///     nothing unless the covered routes AGREE -- a scalar cannot
    ///     honestly describe a node whose routes disagree, and over-
    ///     claiming would push a client onto BTP for a route that never
    ///     needed it.
    #[serde(rename = "requiredTransport", skip_serializing_if = "Option::is_none")]
    pub required_transport: Option<String>,
    #[serde(rename = "edgeIdentity", skip_serializing_if = "Option::is_none")]
    pub edge_identity: Option<EdgeIdentity>,
    pub routes: RouteHints,
    /// The operator notice (toon#183, issue #912) -- config-only, and
    /// absent whenever `[announce]` carries no `notice_*` fields, so an
    /// unconfigured node's announce is byte-identical to before this field
    /// existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<Notice>,
}

/// The wire shape of an operator notice, field-for-field
/// `packages/announcer/src/event.ts`'s `OperatorNotice` -- a pointer, not
/// the payload.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Notice {
    pub id: String,
    pub severity: String,
    pub summary: String,
    pub url: String,
}

impl From<&connector_config::AnnounceNotice> for Notice {
    fn from(notice: &connector_config::AnnounceNotice) -> Self {
        Notice {
            id: notice.id.clone(),
            severity: notice.severity.clone(),
            summary: notice.summary.clone(),
            url: notice.url.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EdgeIdentity {
    #[serde(rename = "keyId")]
    pub key_id: String,
    #[serde(rename = "publicKey")]
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RouteHints {
    pub publish: String,
    pub store: String,
}

/// Assemble the announce from what this node already knows about itself.
///
/// This is where being in-process pays off. The sidecar polled the Rust
/// edge over HTTP for every one of these facts (`ANNOUNCER_RUST_EDGE_URL`,
/// `fetchIdentity`/`fetchGreeting`) *purely* because it was a separate
/// process; here the settlement terms come from the very `[settlement.*]`
/// tables the node verified against a chain at startup, the prices from the
/// same `client_route_price` lookup the x402 greeting itself answers with,
/// and the edge identity from the signer directly. Nothing is polled, so
/// nothing can be polled *wrong* -- and, unlike the sidecar, the settlement
/// facts announced are unambiguously THIS node's rather than whichever
/// edge happened to be asked.
pub fn build_announcement(config: &Config, runtime: &Runtime) -> IlpPeerInfo {
    let announce = config
        .announce()
        .expect("caller checked the [announce] section is present");

    let mut supported_chains: Vec<String> = Vec::new();
    let mut settlement_addresses = BTreeMap::new();
    let mut token_networks = BTreeMap::new();
    let mut preferred_tokens = BTreeMap::new();

    for terms in &runtime.settlements {
        // Core's kind:10032 schema wants a qualified chain id, and a Solana
        // backend reports a bare `"solana"` because its program id already
        // names one deployed instance -- so the announce re-qualifies it,
        // exactly as `announce-builder.ts` does.
        let (chain, settlement_address, network, token) = match terms {
            connector_client_edge::X402ChainSettlementTerms::Evm(evm) => (
                evm.chain.clone(),
                evm.settlement_address.clone(),
                evm.token_network.clone(),
                evm.token_address.clone(),
            ),
            connector_client_edge::X402ChainSettlementTerms::Solana(solana) => (
                announce.solana_chain_id().to_string(),
                solana.settlement_address.clone(),
                solana.program_id.clone(),
                solana.token_address.clone(),
            ),
        };
        if !supported_chains.contains(&chain) {
            supported_chains.push(chain.clone());
        }
        settlement_addresses.insert(chain.clone(), settlement_address);
        token_networks.insert(chain.clone(), network);
        preferred_tokens.insert(chain, token);
    }

    // What THIS node charges for each address it announces, from the same
    // longest-prefix lookup the client edge greets with -- so a client that
    // reads the announce and one that asks the edge get the same number.
    // An address with no route this node serves is simply absent, which is
    // what the sidecar's failed greeting poll produced too.
    let mut route_prices = BTreeMap::new();
    for address in announce.addresses() {
        if let Some(price) = runtime.connector.client_route_price(address) {
            route_prices.insert(address.clone(), price.to_string());
        }
    }
    // And which carriage it will accept the packet over, off the SAME
    // lookup for the same reason (see `IlpPeerInfo::required_transport`):
    // the transport policy and the price are two halves of one answer, and
    // a client that reads one from the announce and discovers the other by
    // being refused has paid to learn it.
    //
    // Only the addresses this announce COVERS are consulted.
    let required_transport = announced_required_transport(announce.addresses(), |address| {
        runtime
            .connector
            .client_route(address)
            .map(|route| route.transport_policy)
    });
    let edge_identity = runtime
        .signer
        .public_key()
        .ok()
        .map(|public_key| EdgeIdentity {
            key_id: runtime.signer.key_id(),
            public_key: format!("0x{}", hex_encode(&public_key)),
        });

    IlpPeerInfo {
        ilp_address: announce.primary_address().to_string(),
        // Emitted only when it says something the singular field does not,
        // matching the builder's `ilpAddresses.length > 1` guard.
        ilp_addresses: (announce.addresses().len() > 1).then(|| announce.addresses().to_vec()),
        btp_endpoint: announce.btp_endpoint().to_string(),
        http_endpoint: announce.http_endpoint().to_string(),
        relay_url: announce.relay_url().map(str::to_string),
        asset_code: announce.asset_code().to_string(),
        asset_scale: announce.asset_scale(),
        supported_chains,
        settlement_addresses,
        token_networks,
        preferred_tokens,
        route_prices,
        required_transport,
        edge_identity,
        routes: RouteHints {
            publish: announce.route_publish().to_string(),
            store: announce.route_store().to_string(),
        },
        notice: announce.notice().map(Notice::from),
    }
}

/// The one transport every announced address's route requires, or `None`
/// when there is no single honest answer -- the value behind
/// [`IlpPeerInfo::required_transport`].
///
/// `route_transport` is the per-address lookup rather than a `&Connector`
/// so this rule can be exercised without standing up a runtime: the rule is
/// the part that has to be right.
///
/// `None` in three distinct cases, all of which mean "say nothing":
///
///   * no announced address resolves to a route this node serves (the store
///     box's `[announce].addresses` before it terminated anything, and any
///     node whose announce runs ahead of its routing table);
///   * the routes that do resolve disagree, which no per-node scalar can
///     describe -- see [`IlpPeerInfo::required_transport`] on why the field
///     is per node in the first place;
///   * they agree on [`TransportPolicy::Both`], the permissive default
///     every route had before issue #701. Emitting `"both"` would be true
///     but useless, and it would put a new key on every announce in the
///     fleet to say nothing -- against this schema's own standing rule that
///     a parser written before a field existed must be unaffected by it.
///
/// `pub` for one reason: `crates/connector-bin/tests/devnet_configs_load.rs`
/// runs it over the COMMITTED devnet files, so "the relay box's announce
/// declares the requirement its route enforces" is a property of the files
/// in this repo rather than of a config a test wrote for itself.
pub fn announced_required_transport(
    addresses: &[String],
    route_transport: impl Fn(&str) -> Option<TransportPolicy>,
) -> Option<String> {
    let mut policies = addresses
        .iter()
        .filter_map(|address| route_transport(address));
    let first = policies.next()?;
    if !policies.all(|policy| policy == first) {
        return None;
    }
    // `name()` is the same spelling the x402 greeting's
    // `extra.requiredTransport` already uses (`connector-client-edge`'s
    // `x402_terms_body`), so the two surfaces cannot drift into describing
    // one policy by two names.
    (first != TransportPolicy::Both).then(|| first.name().to_string())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── negotiating with the through-URL, free and unauthenticated ───────────────

/// The terms an edge answered an unpaid PREPARE with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Terms {
    pub price: u64,
    /// The destination the greeting echoed back -- see the module header:
    /// this confirms a destination, it never supplies one.
    pub pay_to: String,
    /// The EIP-712 domain **that node's** claim gate will verify a claim
    /// under, from `extra.settlement` (or the first EVM entry of
    /// `extra.settlements`). `None` for a target with no EVM settlement
    /// backend, which therefore cannot be paid by channel claim at all.
    pub settlement: Option<EvmDomain>,
    /// `extra.requiredTransport` (issue #701): present, and self-
    /// diagnosing, exactly when the greeting answers a request that arrived
    /// over a transport the route's policy does not accept.
    ///
    /// The probing PREPARE arrives over HTTP, so `Some("btp")` here means
    /// this route cannot be paid over HTTP **at all**. That is not
    /// hypothetical: the devnet apex pins `g.toon.relay` to
    /// `transport = "btp"` for huddles' persistent sessions, which is
    /// exactly the route an announce on that fleet publishes to. Read so
    /// the client path can say so plainly instead of buying an answer it
    /// cannot decode.
    pub required_transport: Option<String>,
    /// `extra.sessionLeaseTtlMs` -- the backstop TTL the target's own
    /// client session registry enforces. Always present, unlike the fields
    /// above. Read so a one-shot BTP announce waits for its answer inside
    /// the window the far side will actually hold the session open for,
    /// rather than assuming a session lives forever.
    pub session_lease_ttl_ms: Option<u64>,
}

/// Parse the x402 v2 greeting body. Tolerant of fields it does not read
/// (`requiredTransport`, `sessionLeaseTtlMs`, the Solana settlement entry):
/// a greeting that grows a field must not break an announce.
///
/// Note what is NOT taken from here: the settlement facts the announce
/// itself advertises. Those are this node's own, read from its own
/// `[settlement.*]` tables -- the greeting's are the *target's*, and on a
/// fleet where every node points at one registry the two coincide, which is
/// exactly the coincidence that would make a mix-up invisible.
pub fn parse_terms(body: &str) -> Option<Terms> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let option = parsed.get("accepts")?.get(0)?;
    let extra = option.get("extra");
    let settlement = extra
        .and_then(|extra| extra.get("settlement"))
        .and_then(parse_evm_domain)
        .or_else(|| {
            extra
                .and_then(|extra| extra.get("settlements"))
                .and_then(serde_json::Value::as_array)?
                .iter()
                .find_map(parse_evm_domain)
        });
    Some(Terms {
        price: option.get("amount")?.as_str()?.parse().ok()?,
        pay_to: option.get("payTo")?.as_str()?.to_string(),
        settlement,
        required_transport: extra
            .and_then(|extra| extra.get("requiredTransport"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        session_lease_ttl_ms: extra
            .and_then(|extra| extra.get("sessionLeaseTtlMs"))
            .and_then(serde_json::Value::as_u64),
    })
}

/// One settlement entry as an [`EvmDomain`], or `None` when it is not an
/// EVM one. `chain` is `evm:<chainId>` for EVM and a bare `solana` for
/// Solana (which has no chain id to append), so the prefix alone tells them
/// apart without needing the untagged enum's structural rules here.
fn parse_evm_domain(terms: &serde_json::Value) -> Option<EvmDomain> {
    let chain_id = terms.get("chain")?.as_str()?.strip_prefix("evm:")?;
    Some(EvmDomain {
        chain_id: chain_id.parse().ok()?,
        token_network: decode_hex_20(terms.get("tokenNetwork")?.as_str()?)?,
    })
}

fn decode_hex_20(value: &str) -> Option<[u8; 20]> {
    let value = value.strip_prefix("0x").unwrap_or(value);
    if value.len() != 40 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 20];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// The URL a client-edge sub-path sits at, given the through-URL. The
/// through-URL is the full `POST /ilp` endpoint, so `/ilp/identity` is
/// `<through>/identity` -- built by string append rather than by
/// reconstructing a base, because an operator's `/ilp` may sit under any
/// prefix their terminator puts it behind.
fn under(through_url: &str, suffix: &str) -> String {
    format!("{}/{suffix}", through_url.trim_end_matches('/'))
}

/// The through-URL's own identity -- the key the gift wrap is sealed to, and
/// the single most expensive thing to get wrong (ADR 0018: a forwarding hop
/// carries the wrap as opaque bytes and cannot open it, so a packet sealed
/// to the wrong node is bought, carried, and then rejected F01 with the
/// money already spent).
async fn fetch_identity(
    client: &reqwest::Client,
    through_url: &str,
) -> Result<PublicKeyBytes, AnnounceError> {
    let url = under(through_url, "identity");
    let body: serde_json::Value = client
        .get(&url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| AnnounceError::Negotiation {
            url: url.clone(),
            reason: error.to_string(),
        })?
        .json()
        .await
        .map_err(|error| AnnounceError::Negotiation {
            url: url.clone(),
            reason: error.to_string(),
        })?;
    let hex = body["publicKey"]
        .as_str()
        .ok_or_else(|| AnnounceError::Negotiation {
            url: url.clone(),
            reason: format!("no publicKey in the identity answer: {body}"),
        })?;
    decode_public_key(hex).ok_or(AnnounceError::Negotiation {
        url,
        reason: format!("'{hex}' is not a 65-byte uncompressed secp256k1 public key"),
    })
}

fn decode_public_key(value: &str) -> Option<PublicKeyBytes> {
    let value = value.strip_prefix("0x").unwrap_or(value);
    if value.len() != 130 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 65];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Ask the through-URL what it charges to deliver to `destination`, by
/// sending it an unpaid PREPARE and reading the x402 greeting it answers --
/// free, unauthenticated, and changing nothing on either side (issue #526's
/// guarantee: an unpaid request is answered with terms and never reaches
/// the app).
///
/// The PREPARE carries an empty body and a condition nothing can fulfil, on
/// purpose: it is a question, and there is no world in which it should be
/// answered by doing work.
async fn fetch_terms(
    client: &reqwest::Client,
    through_url: &str,
    destination: &str,
) -> Result<Terms, AnnounceError> {
    let probe = Prepare {
        amount: 0,
        expires_at: Utc::now() + ChronoDuration::minutes(PREPARE_TTL_MINUTES),
        execution_condition: [0u8; 32],
        destination: destination.to_string(),
        data: Vec::new(),
    };
    let response = client
        .post(through_url)
        .body(probe.encode())
        .send()
        .await
        .map_err(|error| AnnounceError::Negotiation {
            url: through_url.to_string(),
            reason: error.to_string(),
        })?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    parse_terms(&body).ok_or(AnnounceError::NoTerms {
        url: through_url.to_string(),
        status,
        body: body.chars().take(400).collect(),
    })
}

// ── paying like any other client ─────────────────────────────────────────────

/// The header a client-edge claim rides in, base64 of the claim JSON.
const CLAIM_HEADER: &str = "ilp-payment-channel-claim";

// What the header CARRIES is built and signed nowhere near here any more.
// `OutboundClientLedger` in `connector-runtime` holds the three steps that
// used to live in this file -- ask the RECEIVER for the watermark, advance
// it by exactly this packet's amount, sign the claim (issue #873). They
// moved because the forwarding path needs the same three steps to pay a
// next hop, and two copies of a nonce rule is one copy too many.

/// POST the paid PREPARE to the through-URL, exactly as any other client of
/// that node does: the encoded packet as the body, the claim base64'd into
/// the `ilp-payment-channel-claim` header, and the answer read as an OER
/// FULFILL or REJECT.
///
/// Nothing about this node's routing table is involved. That is the whole
/// difference from [`AnnounceOptions::via_own_routing`], and it is what lets
/// a node with no route to the relay -- and no peering it can originate
/// over -- announce itself anyway.
async fn send_as_client(
    client: &reqwest::Client,
    through_url: &str,
    prepare: &Prepare,
    claim: &str,
) -> Result<Fulfill, AnnounceError> {
    let response = client
        .post(through_url)
        .header(CLAIM_HEADER, BASE64.encode(claim.as_bytes()))
        .body(prepare.encode())
        .send()
        .await
        .map_err(|error| AnnounceError::Negotiation {
            url: through_url.to_string(),
            reason: error.to_string(),
        })?;
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| AnnounceError::Negotiation {
            url: through_url.to_string(),
            reason: error.to_string(),
        })?;

    if let Ok(fulfill) = Fulfill::decode(&bytes) {
        return Ok(fulfill);
    }
    match Reject::decode(&bytes) {
        Ok(reject) => Err(reject_error(&reject)),
        Err(_) => Err(AnnounceError::UnreadableAnswer {
            status,
            body: String::from_utf8_lossy(&bytes).chars().take(400).collect(),
        }),
    }
}

// ── the BTP carriage ─────────────────────────────────────────────────────────

/// The BTP request id this one-shot announce uses. A session that sends
/// exactly one MESSAGE and reads its answer needs no allocator -- correlation
/// is by this id, and there is nothing else outstanding to collide with.
const ANNOUNCE_REQUEST_ID: u32 = 1;

/// The longest this command will hold a BTP session open waiting for its
/// answer, before the far side's own `sessionLeaseTtlMs` is taken into
/// account.
const BTP_ANSWER_TIMEOUT: Duration = Duration::from_secs(60);

/// Pay `btp_url` over one BTP session, as a client (client-edge-spec.md
/// §1.9, ADR 0026).
///
/// The shape is deliberately the *smallest* thing that is a real session,
/// because a one-shot announce is not a huddle:
///
///   * **no `auth` frame.** The client edge trusts nothing from the
///     handshake -- "authorization to write comes from each frame's claim,
///     exactly as on HTTP" -- and an `auth` MESSAGE only binds a session
///     registry entry so the connector can push to it later. A one-shot
///     buyer has nothing to be pushed;
///   * **one MESSAGE**, carrying the encoded PREPARE in the frame's own
///     ILP-packet field and the claim as a `payment-channel-claim`
///     protocolData entry. Note the claim is **raw JSON bytes here**, where
///     the HTTP header is base64 of the same JSON -- the one real
///     difference between the two carriages' claim carriage, and an easy
///     hour to lose;
///   * the answer is the RESPONSE bearing this request id, whose ILP-packet
///     field is the FULFILL or REJECT. An ERROR frame, or a
///     `payment-required` protocolData entry, is the same refusal the HTTP
///     402 is and is reported as such.
///
/// The frame bytes come from [`connector_btp`], the one codec both roles
/// share (ADR 0027, issue #713) and the one `connector-vectors` pins --
/// never re-derived here.
async fn send_over_btp(
    btp_url: &str,
    prepare: &Prepare,
    claim: &str,
    session_lease: Option<Duration>,
) -> Result<Fulfill, AnnounceError> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let failed = |reason: String| AnnounceError::Btp {
        url: btp_url.to_string(),
        reason,
    };

    // A session the far side would drop mid-flight is not a longer wait, it
    // is a wait that ends in silence -- so the answer window is the shorter
    // of this command's own ceiling and the lease the greeting advertises.
    let deadline = session_lease
        .filter(|lease| *lease < BTP_ANSWER_TIMEOUT)
        .unwrap_or(BTP_ANSWER_TIMEOUT);

    let (mut socket, _response) = tokio::time::timeout(
        NEGOTIATION_TIMEOUT,
        tokio_tungstenite::connect_async(btp_url),
    )
    .await
    .map_err(|_| failed("timed out opening the websocket".to_string()))?
    .map_err(|error| failed(error.to_string()))?;

    let frame = connector_btp::encode_message(
        ANNOUNCE_REQUEST_ID,
        &[connector_btp::ProtocolData {
            name: connector_btp::CLAIM_PROTOCOL.to_string(),
            content_type: connector_btp::CONTENT_TYPE_TEXT,
            // Raw JSON, NOT base64 -- see this function's own docs.
            data: claim.as_bytes().to_vec(),
        }],
        &prepare.encode(),
    );
    socket
        .send(Message::Binary(frame))
        .await
        .map_err(|error| failed(error.to_string()))?;

    let answer = tokio::time::timeout(deadline, async {
        while let Some(message) = socket.next().await {
            let bytes = match message.map_err(|error| failed(error.to_string()))? {
                Message::Binary(bytes) => bytes,
                // Text/ping/pong/close carry nothing this command asked
                // for; the websocket layer answers ping itself.
                Message::Close(_) => {
                    return Err(failed("the session closed before answering".to_string()))
                }
                _ => continue,
            };
            let decoded = connector_btp::decode_frame(&bytes)
                .map_err(|error| failed(format!("undecodable frame: {error:?}")))?;
            if decoded.request_id != ANNOUNCE_REQUEST_ID {
                continue;
            }
            return Ok(decoded);
        }
        Err(failed(
            "the session ended without answering this request".to_string(),
        ))
    })
    .await
    .map_err(|_| {
        failed(format!(
            "no answer within {}s (the greeting's own session lease was {})",
            deadline.as_secs(),
            session_lease
                .map(|lease| format!("{}ms", lease.as_millis()))
                .unwrap_or_else(|| "not advertised".to_string())
        ))
    })??;

    // Close politely rather than dropping the socket: this session exists
    // for one packet and the far side has a registry entry to retire.
    let _ = socket.close(None).await;

    if answer.frame_type == connector_btp::BTP_ERROR {
        return Err(failed(format!(
            "the far side answered a BTP ERROR: {}",
            String::from_utf8_lossy(&answer.ilp_packet)
        )));
    }
    // The BTP twin of the HTTP 402: §1.9 carries the identical x402 terms
    // bytes as `payment-required` protocolData on a REJECT.
    if let Some(terms) = answer
        .protocol_data
        .iter()
        .find(|pd| pd.name == connector_btp::PAYMENT_REQUIRED_PROTOCOL)
    {
        return Err(AnnounceError::UnreadableAnswer {
            status: 402,
            body: String::from_utf8_lossy(&terms.data)
                .chars()
                .take(400)
                .collect(),
        });
    }
    if let Ok(fulfill) = Fulfill::decode(&answer.ilp_packet) {
        return Ok(fulfill);
    }
    match Reject::decode(&answer.ilp_packet) {
        Ok(reject) => Err(reject_error(&reject)),
        Err(_) => Err(AnnounceError::UnreadableAnswer {
            status: 0,
            body: format!(
                "a BTP {} frame whose ILP packet is neither a FULFILL nor a REJECT",
                answer.frame_type
            ),
        }),
    }
}

// ── the arithmetic ───────────────────────────────────────────────────────────

/// What this node must put on the PREPARE, and the minimum that must still
/// be delivered after every hop takes its cut.
///
/// ADR 0028's arithmetic, from the originating side. This node forwards
/// `amount - fee` over a peering, and since #754 the terminating side
/// charges its OWN price on ARRIVAL -- so the amount has to cover the
/// terminus price *plus* whatever this hop retains. `g.toon.ario` is priced
/// 1002/fee 2 at the devnet apex for exactly this reason: at 1000/fee 2 the
/// far side receives 998, refuses F03, and it reads like a client bug while
/// being a config bug.
///
/// A destination this node TERMINATES has no fee and no arrival charge --
/// it is this node's own app -- so the amount is simply the price, which is
/// what its own edge would have quoted anyway.
pub fn amount_to_pay(config: &Config, destination: &str, terminus_price: u64) -> (u64, u64) {
    let fee = forwarding_fee(config, destination).unwrap_or(0);
    (terminus_price.saturating_add(fee), terminus_price)
}

/// The `fee` of the `[[routes]]` entry that would FORWARD `destination` over
/// a peering, or `None` when no peer route matches -- i.e. when this node
/// either terminates the destination itself or cannot route it at all.
///
/// Two callers, and the second is why this is its own function rather than
/// an expression inside [`amount_to_pay`]: forwarding over a peering is
/// exactly the condition under which an announce would sign an outbound
/// claim, and so exactly the condition [`refuse_if_a_second_process_would_fork_the_ledger`]
/// has to check.
fn forwarding_fee(config: &Config, destination: &str) -> Option<u64> {
    config
        .peer_routes()
        .iter()
        .filter(|route| route_matches(route.prefix(), destination))
        .max_by_key(|route| route.prefix().len())
        .map(|route| route.fee())
}

/// ILP longest-prefix matching's own rule: a prefix matches a destination
/// when they are equal or the destination continues it at a segment
/// boundary. `g.toon.relay` must not match `g.toon.relayed`.
fn route_matches(prefix: &str, destination: &str) -> bool {
    destination == prefix
        || (destination.starts_with(prefix)
            && destination.as_bytes().get(prefix.len()) == Some(&b'.'))
}

// ── the guard ────────────────────────────────────────────────────────────────

/// Refuse to announce when doing so would make this process a **second
/// writer** on a serving node's outbound claim ledger.
///
/// This is the sharpest hazard in the whole subcommand and it is invisible
/// until it has already happened. A node's outbound peer-claim ledger lives
/// in memory and is REPLAYED from `state_dir`'s journal at startup; the
/// journal itself is a plain append-only file with no lock. Two processes
/// over one `state_dir` therefore both resume at nonce N, both sign N+1
/// against different cumulative amounts, and the counterparty refuses one of
/// them as a replay -- after which the serving node's claims never advance
/// the far side's watermark again and the peering silently stops being paid
/// until somebody restarts it.
///
/// Three things must all hold before that can happen, and all three are
/// checked, because a guard that refuses more than the hazard is a guard
/// operators route around:
///
///   1. the node keeps durable money state at all (`state_dir`);
///   2. the announce would **forward over a peering** -- an outbound claim
///      is signed by `forward_via_peer_route` and nowhere else, so an
///      announce to a route this node TERMINATES writes no journal entry
///      and is perfectly safe beside a running node. That is the apex
///      publishing to its own relay, which is the common case;
///   3. something is actually listening on this config's client edge.
///
/// The third is detected by dialing rather than by taking a lock,
/// deliberately: a lock would have to be taken on the SERVING path too, and
/// a serving path that can refuse to start is a new way to lose a deploy. A
/// listening client edge is proof enough that a connector is up, and it is
/// exactly the case a `docker exec` into a running container hits.
async fn refuse_if_a_second_process_would_fork_the_ledger(
    config: &Config,
    destination: &str,
) -> Result<(), AnnounceError> {
    if config.state_dir().is_none() || forwarding_fee(config, destination).is_none() {
        return Ok(());
    }
    let configured = config.client_edge_addr();
    // A wildcard bind is not dialable as written; the process behind it is
    // reachable on loopback, which is where a `docker exec` sits.
    let addr = match configured.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => {
            SocketAddr::from(([127, 0, 0, 1], configured.port()))
        }
        IpAddr::V6(ip) if ip.is_unspecified() => {
            SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], configured.port()))
        }
        _ => configured,
    };
    let reachable = tokio::time::timeout(
        Duration::from_millis(500),
        tokio::net::TcpStream::connect(addr),
    )
    .await
    .map(|result| result.is_ok())
    .unwrap_or(false);
    if reachable {
        return Err(AnnounceError::AlreadyServing { addr });
    }
    Ok(())
}

/// The 32-byte secret this announce signs its Nostr event with (issue
/// #799): `[announce] identity_key_file` when the operator has carried one
/// over, or this node's own `[signer]` identity otherwise -- the same
/// default this command had before the field existed. A Nostr signature
/// needs the scalar itself (see `connector_signer::nostr`), so a KMS-held
/// `[signer]` identity cannot announce unless `identity_key_file` supplies
/// one -- said plainly rather than discovered as a panic.
///
/// Split out of [`announce`] so this resolution -- and therefore the exact
/// pubkey a given key file produces -- is testable on its own, without the
/// network calls the rest of the command makes.
fn resolve_announce_identity(
    config: &Config,
    announce_config: &AnnounceConfig,
) -> Result<[u8; 32], AnnounceError> {
    if let Some(path) = announce_config.identity_key_file() {
        return Ok(read_announce_identity_secret(path)?);
    }
    match config.signer_key() {
        location @ SecretLocation::File(_) => Ok(read_signer_secret(location)?),
        SecretLocation::Kms { .. } => Err(AnnounceError::UnsignableIdentity),
    }
}

// ── the whole thing ──────────────────────────────────────────────────────────

/// What an announce produced, for the caller to print.
#[derive(Debug)]
pub struct AnnounceOutcome {
    /// The signed event -- printed on a dry run, and worth having on a real
    /// one so an operator can look the id up on the relay afterwards.
    pub event: NostrEvent,
    /// The address it was (or would be) published to.
    pub destination: String,
    /// What was (or would have been) put on the PREPARE.
    pub amount: u64,
    /// False on a dry run: everything below was computed and nothing was
    /// paid or sent.
    pub sent: bool,
}

/// Announce this node through `options.through_url`, paying through its own
/// routing.
pub async fn announce(
    config: &Config,
    options: &AnnounceOptions,
) -> Result<AnnounceOutcome, AnnounceError> {
    let announce_config = config
        .announce()
        .ok_or(AnnounceError::NoAnnounceSection)?
        .clone();
    let destination = options
        .publish_to
        .clone()
        .or_else(|| announce_config.publish_to().map(str::to_string))
        .ok_or(AnnounceError::NoDestination)?;

    reqwest::Url::parse(&options.through_url)
        .map_err(|error| AnnounceError::InvalidThroughUrl {
            value: options.through_url.clone(),
            reason: error.to_string(),
        })
        .and_then(|url| {
            url.host_str()
                .map(|_| ())
                .ok_or_else(|| AnnounceError::InvalidThroughUrl {
                    value: options.through_url.clone(),
                    reason: "the URL names no host".to_string(),
                })
        })?;

    // The ledger guard applies to the ROUTING path only, and that is not a
    // convenience -- it is the reason the client path is the default.
    //
    // An outbound PEER claim is signed by `forward_via_peer_route` and
    // journaled under `state_dir`, which is the state two processes cannot
    // share. The client path signs a CLIENT claim instead, by hand, against
    // a channel whose watermark authority is the RECEIVER (asked over
    // `POST /ilp/claim-state`, never remembered locally) -- and it never
    // touches `ClientPayoutLedger`, which is assembled in `router()` and
    // `router()` is never called here. So there is no local mutable money
    // state to fork, and nothing to guard.
    //
    // Re-checked when `[[pay_channels]]` gave a SERVING node a file-backed
    // outbound client ledger of its own (ADR 0042 item 2, issue #881), and
    // the guard needed no widening. `crate::build` below *opens* that
    // ledger, which is a read -- the same read it already performs on the
    // peer journal -- and only `Connector::cover_forward` ever appends to
    // it, reached solely from `forward_via_peer_route`: the very call
    // condition (2) above already detects. So the routing path is guarded
    // for both books at once and the client path still appends to neither
    // (it signs from `OutboundClientLedger::in_memory`, deliberately). A
    // fork of the client book would also be the milder one -- the receiver
    // is the authority there, so it costs one refused packet and the next
    // watermark ask recovers, where a forked PEER journal silently stops
    // the peering being paid until somebody restarts it.
    if !options.dry_run && options.via_own_routing {
        refuse_if_a_second_process_would_fork_the_ledger(config, &destination).await?;
    }

    let secret = resolve_announce_identity(config, &announce_config)?;

    let runtime = crate::build(config).await?;

    let client = reqwest::Client::builder()
        .timeout(NEGOTIATION_TIMEOUT)
        .build()
        .map_err(|error| AnnounceError::Negotiation {
            url: options.through_url.clone(),
            reason: error.to_string(),
        })?;
    let terms = fetch_terms(&client, &options.through_url, &destination).await?;
    // The greeting's `payTo` echoes the destination it was asked about (see
    // this module's header), so it can only ever confirm -- but a
    // disagreement means the far end is not the client edge this code
    // thinks it is, which is worth saying before money moves rather than
    // after.
    if terms.pay_to != destination {
        tracing::warn!(
            asked = %destination,
            answered = %terms.pay_to,
            "the through-URL's terms name a different destination than the one asked about"
        );
    }
    let identity = fetch_identity(&client, &options.through_url).await?;

    let info = build_announcement(config, &runtime);
    let content = serde_json::to_string(&info).expect("an IlpPeerInfo always serializes");
    let created_at = Utc::now().timestamp().max(0) as u64;
    let event = sign_ilp_peer_info(&secret, content, created_at, announce_config.ttl_secs())
        .map_err(|error| AnnounceError::Signing(error.to_string()))?;

    // Two different arithmetics, because they are two different roles.
    //
    // As a CLIENT (the default) this node arrives at the through-URL's edge
    // like any buyer and pays exactly what that edge quotes -- whatever it
    // does downstream, and whatever it retains, is its business and is
    // already inside the quoted price (ADR 0028).
    //
    // Originating through its OWN routing, it is the first hop: it forwards
    // `amount - fee`, and since #754 the terminating side charges its own
    // price on arrival -- so the amount must cover both.
    let (amount, minimum_delivery) = if options.via_own_routing {
        amount_to_pay(config, &destination, terms.price)
    } else {
        (terms.price, terms.price)
    };

    // A dry run negotiates -- an operator asking "what will this say and
    // what will it cost" deserves both answers -- and stops one step short
    // of the only line that spends anything.
    if options.dry_run {
        return Ok(AnnounceOutcome {
            event,
            destination,
            amount,
            sent: false,
        });
    }

    let body = serde_json::json!({ "event": event })
        .to_string()
        .into_bytes();
    let (prepare, shared_secret) = sealed_prepare(
        amount,
        &destination,
        options.target.as_deref().unwrap_or(""),
        &body,
        &identity,
    )?;

    let fulfill = if options.via_own_routing {
        tracing::info!(
            destination = %destination,
            through = %options.through_url,
            amount,
            minimum_delivery,
            event_id = %event.id,
            "originating the announce through this node's own routing"
        );
        // The same call `POST /packets` makes, with no operator surface in
        // front of it (issue #753) and no second process holding a key.
        match runtime
            .connector
            .handle_prepare(prepare, minimum_delivery)
            .await
        {
            PacketResponse::Fulfill(fulfill) => fulfill,
            PacketResponse::Reject(reject) => return Err(reject_error(&reject)),
        }
    } else {
        pay_the_through_url(config, &client, options, &terms, &prepare, amount, &event).await?
    };

    read_relay_answer(&fulfill, &shared_secret)?;
    Ok(AnnounceOutcome {
        event,
        destination,
        amount,
        sent: true,
    })
}

/// The default send path: pay the through-URL directly, as an ordinary
/// client of that node.
///
/// Everything a claim needs comes from somewhere that cannot be wrong:
///
///   * the **key** is `[settlement.evm]`'s -- the channel's on-chain
///     participant IS this node's settlement address, which is why there is
///     no second key here and none is invented;
///   * the **domain** is the target's own greeting, because its gate
///     recovers the signer under the domain IT resolved for the channel;
///   * the **nonce and cumulative amount** are the target's own claim state,
///     because the receiver is the authority on its own watermark.
///
/// Only the channel id is configured, because only the channel id is a fact
/// about the world that nothing on either side can derive.
#[allow(clippy::too_many_arguments)]
async fn pay_the_through_url(
    config: &Config,
    client: &reqwest::Client,
    options: &AnnounceOptions,
    terms: &Terms,
    prepare: &Prepare,
    amount: u64,
    event: &NostrEvent,
) -> Result<Fulfill, AnnounceError> {
    let announce_config = config
        .announce()
        .expect("caller checked the [announce] section is present");
    // Which carriage, decided by NEGOTIATION rather than by being told.
    //
    // `handle_ilp` checks a route's transport policy BEFORE it checks
    // payment, so a route pinned to one carriage answers a paid request on
    // any other with the same x402 terms it answers an unpaid one, however
    // correct the claim. The greeting says which (issue #701's
    // self-diagnosing `requiredTransport`), so this picks rather than
    // guesses -- and a route with no restriction, like `g.toon.ario` today,
    // stays on HTTP.
    let carriage = match terms.required_transport.as_deref() {
        None | Some("http") => Carriage::Http,
        Some("btp") => Carriage::Btp(
            options
                .btp_url
                .clone()
                .or_else(|| announce_config.publish_btp_url().map(str::to_string))
                .ok_or_else(|| AnnounceError::NoBtpEndpoint {
                    destination: prepare.destination.clone(),
                    through_url: options.through_url.clone(),
                })?,
        ),
        Some(required) => {
            return Err(AnnounceError::WrongTransport {
                destination: prepare.destination.clone(),
                required: required.to_string(),
            })
        }
    };

    let channel = *announce_config
        .pay_channel()
        .ok_or(AnnounceError::NoPayChannel)?;
    let domain = terms
        .settlement
        .ok_or_else(|| AnnounceError::NoSettlementTerms {
            url: options.through_url.clone(),
        })?;

    let evm = config
        .settlements()
        .iter()
        .find_map(|settlement| match settlement {
            SettlementConfig::Evm(evm) => Some(evm),
            SettlementConfig::Solana(_) => None,
        })
        .ok_or(AnnounceError::NoSettlementIdentity)?;
    let signer =
        LocalSigner::from_secret_bytes("announce-claim", read_settlement_key_bytes(evm.key())?)
            .map_err(|error| AnnounceError::Signing(error.to_string()))?;

    // In MEMORY, deliberately, and this is the one place the CLI's use of
    // the shared ledger differs from the serving node's.
    //
    // A file-backed ledger exists to stop a RESTART reissuing a nonce, and
    // an announce has no restart to survive: it signs at most one claim in
    // its whole life and the next invocation asks the receiver again from
    // scratch. Giving it a file under `state_dir` would put a second writer
    // beside a running node's own money state -- exactly the fork
    // [`refuse_if_a_second_process_would_fork_the_ledger`] refuses, and
    // that guard does not cover this path precisely because until now this
    // path wrote nothing. It still writes nothing.
    let ledger = OutboundClientLedger::in_memory();
    // The next hop, for a payer arriving as an ordinary client, IS the
    // through-URL: that is the node whose watermark is being advanced and
    // whose nonce line this claim sits on.
    let receiver = HttpClaimState::new(client, &options.through_url, &signer);
    let claim = ledger
        .next_claim(
            &options.through_url,
            &receiver,
            &channel,
            &domain,
            &signer,
            amount,
        )
        .await?;

    tracing::info!(
        destination = %prepare.destination,
        through = %options.through_url,
        carriage = carriage.name(),
        amount,
        nonce = claim.nonce,
        cumulative = %claim.cumulative,
        event_id = %event.id,
        "paying the through-URL directly, as an ordinary client"
    );

    let claim = claim.json;
    match &carriage {
        Carriage::Http => send_as_client(client, &options.through_url, prepare, &claim).await,
        Carriage::Btp(btp_url) => {
            send_over_btp(
                btp_url,
                prepare,
                &claim,
                terms.session_lease_ttl_ms.map(Duration::from_millis),
            )
            .await
        }
    }
}

/// Which carriage this announce pays over, chosen from the greeting.
enum Carriage {
    Http,
    /// The target's BTP endpoint, which had to be supplied -- see
    /// [`AnnounceOptions::btp_url`] for why it cannot be derived.
    Btp(String),
}

impl Carriage {
    fn name(&self) -> &'static str {
        match self {
            Carriage::Http => "http",
            Carriage::Btp(_) => "btp",
        }
    }
}

fn reject_error(reject: &Reject) -> AnnounceError {
    AnnounceError::Rejected {
        code: reject.code.as_str().to_string(),
        triggered_by: reject.triggered_by.clone(),
        message: reject.message.clone(),
    }
}

/// A `Prepare` a real sender forms: an OER `EnvelopeRequest` gift-wrapped to
/// the TERMINATING connector's identity (ADR 0018), under a condition minted
/// from the fulfilment that same wrap's shared secret derives (ADR 0019).
///
/// `identity` is a parameter rather than something this function fetches for
/// the reason `devnet_store_leg_probe.rs` gives for the same choice: the one
/// thing a forwarded packet gets wrong is sealing to the hop instead of the
/// terminus, and passing it in keeps that decision visible at the call site.
fn sealed_prepare(
    amount: u64,
    destination: &str,
    target: &str,
    body: &[u8],
    identity: &PublicKeyBytes,
) -> Result<(Prepare, [u8; 32]), AnnounceError> {
    let plaintext = EnvelopeRequest {
        method: "POST".to_string(),
        target: target.to_string(),
        headers: vec![("content-type".to_string(), "application/json".to_string())],
        body: body.to_vec(),
    }
    .encode();
    let (data, shared_secret) = seal_request(&plaintext, identity)
        .map_err(|error| AnnounceError::Seal(error.to_string()))?;
    Ok((
        Prepare {
            amount,
            expires_at: Utc::now() + ChronoDuration::minutes(PREPARE_TTL_MINUTES),
            execution_condition: derive_condition(&derive_fulfillment(&shared_secret)),
            destination: destination.to_string(),
            data,
        },
        shared_secret,
    ))
}

/// A FULFILL means the packet was PAID FOR and delivered; it does not mean
/// the relay liked the event. The sealed answer carries the write ingress's
/// own HTTP status, and a 4xx there is worth saying out loud -- the money is
/// already spent either way.
fn read_relay_answer(fulfill: &Fulfill, shared_secret: &[u8; 32]) -> Result<(), AnnounceError> {
    let opened = open_response(shared_secret, &fulfill.data)
        .map_err(|error| AnnounceError::Seal(error.to_string()))?;
    let envelope =
        EnvelopeResponse::decode(&opened).map_err(|error| AnnounceError::RelayRefused {
            status: 0,
            body: error.to_string(),
        })?;
    if !(200..300).contains(&envelope.status) {
        return Err(AnnounceError::RelayRefused {
            status: envelope.status,
            body: String::from_utf8_lossy(&envelope.body)
                .chars()
                .take(400)
                .collect(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::Path;

    use connector_signer::to_hex;

    /// Write `secret` to a fresh temp file, as an operator's key file holds
    /// it: 32 raw bytes. Held by the caller, since dropping it deletes it.
    fn key_file(secret: &[u8; 32]) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().expect("temp key file");
        file.write_all(secret).expect("write key file");
        file
    }

    /// The BIP-340 x-only pubkey `secret` announces under, derived through
    /// `k256::schnorr` DIRECTLY rather than through
    /// `connector_signer::nostr` -- see
    /// [`identity_key_file_overrides_the_signer_and_the_announced_pubkey_is_pinned`]
    /// for why the independence matters.
    fn announced_pubkey_of(secret: &[u8; 32]) -> String {
        let signing_key = k256::schnorr::SigningKey::from_bytes(secret).expect("valid scalar");
        hex_encode(&signing_key.verifying_key().to_bytes())
    }

    /// Load a minimal config with `[signer]` pointed at `signer_key` and,
    /// when given, an `[announce]` section pointed at `identity_key`.
    fn config_with_identity(signer_key: &Path, identity_key: Option<&Path>) -> Config {
        let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
        write!(
            config_file,
            r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{signer}"

[announce]
addresses = ["g.toon.ario"]
http_endpoint = "https://proxy.ario.example/ilp"
btp_endpoint = "wss://proxy.ario.example/ilp/btp"
{identity_line}
"#,
            signer = signer_key.display(),
            identity_line = identity_key
                .map(|path| format!(r#"identity_key_file = "{}""#, path.display()))
                .unwrap_or_default(),
        )
        .expect("write config file");
        Config::load(config_file.path()).expect("load config")
    }

    /// The whole point of `[announce] identity_key_file` (issue #799): the
    /// retired sidecar's Nostr identity survives the cutover to this
    /// subcommand byte for byte, so a genesis peer seed pinning its pubkey
    /// does not go stale the day the sidecar is switched off.
    ///
    /// Pinned against an INDEPENDENT BIP-340 derivation (`k256::schnorr`
    /// directly) rather than a second call into
    /// `connector_signer::nostr::sign_ilp_peer_info` -- a bug in that
    /// module's own derivation could not make this test agree with it by
    /// construction, mirroring how `nostr.rs`'s own tests verify the way a
    /// relay verifies rather than by re-deriving through the same code path.
    #[test]
    fn identity_key_file_overrides_the_signer_and_the_announced_pubkey_is_pinned() {
        let signer_secret = [7u8; 32];
        let identity_secret = [9u8; 32];
        let signer_key_file = key_file(&signer_secret);
        let identity_key_file = key_file(&identity_secret);

        let config = config_with_identity(signer_key_file.path(), Some(identity_key_file.path()));
        let announce_config = config.announce().expect("announce section present");

        let secret = resolve_announce_identity(&config, announce_config).expect("resolve");
        assert_eq!(
            secret, identity_secret,
            "identity_key_file must win over [signer]'s own key"
        );

        let event = sign_ilp_peer_info(&secret, "{}".to_string(), 1_700, 600).expect("sign");
        assert_eq!(
            event.pubkey,
            announced_pubkey_of(&identity_secret),
            "the announced pubkey must be the carried-over identity's, never the connector's \
             own [signer] pubkey"
        );
        assert_ne!(
            event.pubkey,
            announced_pubkey_of(&signer_secret),
            "sanity: the signer's own key must produce a DIFFERENT pubkey, or this test would \
             pass even if identity_key_file were silently ignored"
        );
    }

    /// With no `identity_key_file` configured, resolution is unchanged from
    /// before issue #799: the connector's own `[signer]` identity signs the
    /// announce.
    #[test]
    fn with_no_identity_key_file_the_signers_own_key_still_signs() {
        let signer_secret = [7u8; 32];
        let signer_key_file = key_file(&signer_secret);

        let config = config_with_identity(signer_key_file.path(), None);
        let announce_config = config.announce().expect("announce section present");

        let secret = resolve_announce_identity(&config, announce_config).expect("resolve");
        assert_eq!(secret, signer_secret);
    }

    /// The devnet apex's own greeting shape, abridged: the price, the
    /// echoed `payTo`, and the EIP-712 domain a claim must be signed under
    /// -- plus fields this code deliberately does not read
    /// (`requiredTransport` from issue #701 is live on that very route).
    #[test]
    fn terms_are_parsed_out_of_a_real_greeting_including_fields_we_ignore() {
        let body = r#"{"x402Version":2,"resource":{"url":"g.toon.relay"},
            "accepts":[{"scheme":"toon-channel","network":"g.toon.relay","amount":"1002",
            "payTo":"g.toon.relay","maxTimeoutSeconds":60,"httpEndpoint":"/ilp",
            "extra":{"ilpAddress":"g.toon.relay","endpoint":"/ilp","price":"1002",
            "requiredTransport":"btp","sessionLeaseTtlMs":300000,
            "settlement":{"chain":"evm:84532","settlementAddress":"0xf29f",
              "tokenNetworkRegistry":"0xcc90",
              "tokenNetwork":"0x1E95493fEF46707E034b4a1945f25a8C76A1823D",
              "tokenAddress":"0x49be","decimals":6}}}]}"#;

        let terms = parse_terms(body).expect("a real greeting parses");
        assert_eq!(terms.price, 1002);
        assert_eq!(terms.pay_to, "g.toon.relay");
        // Issue #701, and not a hypothetical: the live devnet apex answers
        // exactly this for `g.toon.relay`, which is the route an announce
        // on that fleet publishes to. The client path pays over HTTP, so a
        // `btp` requirement here means it cannot pay this route at all --
        // detected here rather than discovered as an undecodable answer.
        assert_eq!(terms.required_transport.as_deref(), Some("btp"));
        // Read so a one-shot BTP session waits inside the window the far
        // side will actually hold it open for, rather than assuming a
        // session lives forever.
        assert_eq!(terms.session_lease_ttl_ms, Some(300_000));
        // What this recorded apex body does NOT carry, and the reason
        // `--btp-url` is explicit input: there is no BTP endpoint anywhere
        // in it. Issue #807 has since added `extra.btpEndpoint` to the
        // greeting, but only for a target that configures its own
        // `[announce]` -- a target that does not still answers the shape
        // pinned here, which is the one this command must keep working
        // against.
        let extra: serde_json::Value = serde_json::from_str(body).expect("greeting");
        let mut keys: Vec<&str> = extra["accepts"][0]["extra"]
            .as_object()
            .expect("extra object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "endpoint",
                "ilpAddress",
                "price",
                "requiredTransport",
                "sessionLeaseTtlMs",
                "settlement"
            ],
            "this greeting carries no BTP URL -- deriving one would be a guess"
        );
        let domain = terms.settlement.expect("the EIP-712 domain to sign under");
        assert_eq!(domain.chain_id, 84_532);
        assert_eq!(
            to_hex(&domain.token_network),
            "0x1e95493fef46707e034b4a1945f25a8c76a1823d"
        );
    }

    /// A two-chain node lists both legs in `extra.settlements` (issue
    /// #632). Only the EVM one carries a domain a balance proof can be
    /// signed under -- a bare `"solana"` chain has no chain id to sign
    /// against -- so the EVM entry must be found past it.
    #[test]
    fn the_evm_domain_is_found_past_a_solana_entry_in_the_settlements_list() {
        let body = r#"{"accepts":[{"amount":"1000","payTo":"g.toon.relay","extra":{
            "settlements":[
              {"chain":"solana","settlementAddress":"W6yK","programId":"2aEV",
               "tokenAddress":"xyc5","decimals":6},
              {"chain":"evm:31337","settlementAddress":"0x01",
               "tokenNetworkRegistry":"0x02",
               "tokenNetwork":"0x00000000000000000000000000000000000000bb",
               "tokenAddress":"0x03","decimals":6}]}}]}"#;

        let domain = parse_terms(body)
            .expect("parse")
            .settlement
            .expect("the EVM leg");
        assert_eq!(domain.chain_id, 31_337);
        assert_eq!(
            to_hex(&domain.token_network),
            "0x00000000000000000000000000000000000000bb"
        );
    }

    /// A target with no EVM settlement backend advertises no domain, so it
    /// cannot be paid by channel claim -- reported rather than guessed at.
    #[test]
    fn a_settlement_less_target_advertises_no_domain() {
        let body = r#"{"accepts":[{"amount":"1000","payTo":"g.toon.relay",
            "extra":{"ilpAddress":"g.toon.relay","price":"1000"}}]}"#;
        assert_eq!(parse_terms(body).expect("parse").settlement, None);
    }

    /// A 200, a 404 body, or anything that is not an x402 greeting yields
    /// nothing -- so the caller reports "there is nothing to pay" rather
    /// than paying a number it made up.
    #[test]
    fn a_non_greeting_answer_yields_no_terms() {
        for body in [
            "no route this connector serves matches 'g.toon.relay'",
            "{}",
            r#"{"accepts":[]}"#,
            r#"{"accepts":[{"payTo":"g.toon.relay"}]}"#,
        ] {
            assert_eq!(parse_terms(body), None, "{body}");
        }
    }

    #[test]
    fn a_sub_path_is_appended_to_the_through_url_however_it_is_written() {
        assert_eq!(
            under("https://relay-op.example/ilp", "identity"),
            "https://relay-op.example/ilp/identity"
        );
        assert_eq!(
            under("https://relay-op.example/ilp/", "identity"),
            "https://relay-op.example/ilp/identity"
        );
    }

    #[test]
    fn a_prefix_only_matches_at_a_segment_boundary() {
        assert!(route_matches("g.toon.relay", "g.toon.relay"));
        assert!(route_matches("g.toon.relay", "g.toon.relay.ario"));
        assert!(!route_matches("g.toon.relay", "g.toon.relayed"));
        assert!(!route_matches("g.toon.relay", "g.toon"));
    }

    #[test]
    fn a_65_byte_uncompressed_key_decodes_and_nothing_else_does() {
        let hex = format!("04{}", "ab".repeat(64));
        assert!(decode_public_key(&hex).is_some());
        assert!(decode_public_key(&format!("0x{hex}")).is_some());
        assert!(decode_public_key(&"ab".repeat(33)).is_none());
        assert!(decode_public_key(&format!("zz{}", "ab".repeat(64))).is_none());
    }

    /// Minimal `IlpPeerInfo`, for pinning `notice`'s wire shape without
    /// building a full `Runtime` -- `build_announcement` itself just maps
    /// `AnnounceConfig::notice()` through [`Notice::from`], which is the
    /// part worth testing directly.
    fn minimal_info(notice: Option<Notice>) -> IlpPeerInfo {
        IlpPeerInfo {
            ilp_address: "g.toon.ario".to_string(),
            ilp_addresses: None,
            btp_endpoint: "wss://proxy.ario.example/ilp/btp".to_string(),
            http_endpoint: "https://proxy.ario.example/ilp".to_string(),
            relay_url: None,
            asset_code: "USDC".to_string(),
            asset_scale: 6,
            supported_chains: Vec::new(),
            settlement_addresses: BTreeMap::new(),
            token_networks: BTreeMap::new(),
            preferred_tokens: BTreeMap::new(),
            route_prices: BTreeMap::new(),
            required_transport: None,
            edge_identity: None,
            routes: RouteHints {
                publish: "g.toon.ario".to_string(),
                store: "g.toon.ario".to_string(),
            },
            notice,
        }
    }

    /// AC (issue #912): with no notice configured, the announce is
    /// byte-identical to today -- no `notice` key at all, not a null one.
    #[test]
    fn an_unconfigured_notice_is_omitted_from_the_wire_content_entirely() {
        let content = serde_json::to_string(&minimal_info(None)).expect("serialize");
        assert!(
            !content.contains("notice"),
            "content must carry no `notice` key at all: {content}"
        );
    }

    /// A configured notice appears on the announce's own schema field, in
    /// the shape `packages/announcer/src/event.ts`'s `OperatorNotice`
    /// already publishes.
    #[test]
    fn a_configured_notice_appears_on_the_wire_verbatim() {
        let notice = Notice {
            id: "2026-08-relay-migration".to_string(),
            severity: "action-required".to_string(),
            summary: "Read the migration notes before Friday".to_string(),
            url: "https://example.com/notices/1".to_string(),
        };
        let content = serde_json::to_string(&minimal_info(Some(notice))).expect("serialize");
        let parsed: serde_json::Value = serde_json::from_str(&content).expect("parse");
        assert_eq!(
            parsed["notice"],
            serde_json::json!({
                "id": "2026-08-relay-migration",
                "severity": "action-required",
                "summary": "Read the migration notes before Friday",
                "url": "https://example.com/notices/1",
            })
        );
    }

    /// [`Notice::from`] carries every field through unchanged -- the
    /// conversion `build_announcement` uses between `AnnounceConfig`'s
    /// validated notice and the wire struct.
    #[test]
    fn notice_from_announce_notice_carries_every_field() {
        let announce_notice = connector_config::AnnounceNotice {
            id: "id".to_string(),
            severity: "info".to_string(),
            summary: "summary".to_string(),
            url: "https://example.com".to_string(),
        };
        let notice = Notice::from(&announce_notice);
        assert_eq!(notice.id, "id");
        assert_eq!(notice.severity, "info");
        assert_eq!(notice.summary, "summary");
        assert_eq!(notice.url, "https://example.com");
    }

    // ── requiredTransport (issue #701's policy, finally advertised) ──────

    fn addresses(list: &[&str]) -> Vec<String> {
        list.iter().map(|address| address.to_string()).collect()
    }

    /// The devnet relay box's exact shape: one announced address, one
    /// route, pinned `transport = "btp"`. This is the case that was live
    /// and silent -- the enforcement was already there, the advertisement
    /// was not.
    #[test]
    fn a_btp_only_announced_route_advertises_the_transport_it_requires() {
        let required = announced_required_transport(&addresses(&["g.toon.relay"]), |address| {
            (address == "g.toon.relay").then_some(TransportPolicy::Btp)
        });
        assert_eq!(required.as_deref(), Some("btp"));
    }

    /// The store box's shape, and every other ordinary node's: the route is
    /// left at the default, so the announce is byte-identical to one built
    /// before this field existed.
    #[test]
    fn a_default_transport_route_advertises_nothing() {
        let required = announced_required_transport(&addresses(&["g.toon.ario"]), |_| {
            Some(TransportPolicy::Both)
        });
        assert_eq!(required, None);
    }

    /// An address with no route contributes nothing rather than counting as
    /// a disagreement -- `relay_fronting_config`'s `["g.test",
    /// "g.test.relay"]` in `crates/connector-bin/tests/announce_subcommand.rs`
    /// is exactly this, and it is also why `routePrices` can be shorter
    /// than `ilpAddresses`.
    #[test]
    fn an_announced_address_with_no_route_does_not_veto_the_transport() {
        let required =
            announced_required_transport(&addresses(&["g.test", "g.test.relay"]), |address| {
                (address == "g.test.relay").then_some(TransportPolicy::Btp)
            });
        assert_eq!(required.as_deref(), Some("btp"));
    }

    /// Routes that disagree cannot be described by a per-node scalar, so
    /// the field is omitted rather than guessed at from the first or the
    /// strictest. Over-claiming here would push a client onto BTP for the
    /// HTTP-only route, which is the failure this whole field exists to
    /// prevent, arrived at from the other side.
    #[test]
    fn routes_that_disagree_advertise_nothing() {
        let required =
            announced_required_transport(&addresses(&["g.test.relay", "g.test.web"]), |address| {
                match address {
                    "g.test.relay" => Some(TransportPolicy::Btp),
                    "g.test.web" => Some(TransportPolicy::Http),
                    _ => None,
                }
            });
        assert_eq!(required, None);

        // Including the case a reader is likeliest to get wrong: the
        // permissive default disagreeing with a pinned one.
        let required =
            announced_required_transport(&addresses(&["g.test.relay", "g.test.web"]), |address| {
                match address {
                    "g.test.relay" => Some(TransportPolicy::Btp),
                    "g.test.web" => Some(TransportPolicy::Both),
                    _ => None,
                }
            });
        assert_eq!(required, None);
    }

    #[test]
    fn a_node_announcing_addresses_it_has_no_routes_for_advertises_nothing() {
        assert_eq!(
            announced_required_transport(&addresses(&["g.toon.relay"]), |_| None),
            None
        );
        assert_eq!(announced_required_transport(&[], |_| None), None);
    }

    /// The wire shape toon-client's `extractRequiredTransport` reads: a
    /// TOP-LEVEL string on the kind:10032 content, not nested under an
    /// `extra` object (which a kind:10032 content does not have) and not a
    /// null when absent.
    #[test]
    fn required_transport_rides_at_the_root_of_the_content_and_is_omitted_when_absent() {
        let content = serde_json::to_string(&minimal_info(None)).expect("serialize");
        assert!(
            !content.contains("requiredTransport"),
            "an unconfigured node's announce must carry no key at all: {content}"
        );

        let mut info = minimal_info(None);
        info.required_transport = Some("btp".to_string());
        let parsed: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&info).expect("serialize")).expect("parse");
        assert_eq!(
            parsed["requiredTransport"], "btp",
            "toon-client reads JSON.parse(content)['requiredTransport'] off the root \
             (packages/client/src/discovery-subscription.ts): {parsed}"
        );
        assert!(
            parsed.get("extra").is_none(),
            "a kind:10032 content has no `extra` block -- nesting the key would hide it \
             from the only consumer there is: {parsed}"
        );
    }
}
