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

use chrono::{Duration as ChronoDuration, Utc};
use connector_config::{Config, SecretLocation};
use connector_domain::{
    derive_condition, EnvelopeRequest, EnvelopeResponse, Fulfill, PacketResponse, Prepare, Reject,
};
use connector_signer::giftwrap::{derive_fulfillment, open_response, seal_request};
use connector_signer::{sign_ilp_peer_info, NostrEvent, PublicKeyBytes};
use serde::Serialize;

use crate::runtime::{read_signer_secret, Runtime, RuntimeError};

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
        }
    }
}

impl std::error::Error for AnnounceError {}

impl From<RuntimeError> for AnnounceError {
    fn from(source: RuntimeError) -> Self {
        AnnounceError::Runtime(source)
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
    #[serde(rename = "edgeIdentity", skip_serializing_if = "Option::is_none")]
    pub edge_identity: Option<EdgeIdentity>,
    pub routes: RouteHints,
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
        edge_identity,
        routes: RouteHints {
            publish: announce.route_publish().to_string(),
            store: announce.route_store().to_string(),
        },
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── negotiating with the through-URL, free and unauthenticated ───────────────

/// The terms an edge answered an unpaid PREPARE with -- the price, and the
/// destination it echoed back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Terms {
    pub price: u64,
    pub pay_to: String,
}

/// Parse the x402 v2 greeting body. Deliberately tolerant of fields it does
/// not read (`extra.settlement*`, `extra.requiredTransport`,
/// `sessionLeaseTtlMs`): the announce's own settlement facts come from this
/// node, never from the edge it is publishing through, and a greeting that
/// grows a field must not break an announce.
pub fn parse_terms(body: &str) -> Option<Terms> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let option = parsed.get("accepts")?.get(0)?;
    Some(Terms {
        price: option.get("amount")?.as_str()?.parse().ok()?,
        pay_to: option.get("payTo")?.as_str()?.to_string(),
    })
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

    // A dry run signs nothing for the wire and sends nothing, so it is safe
    // beside a running node whatever the destination is -- and it is what an
    // operator wants on a live box, to see what would go out.
    if !options.dry_run {
        refuse_if_a_second_process_would_fork_the_ledger(config, &destination).await?;
    }

    // The identity key, read the same way `build_signer` reads it. A Nostr
    // signature needs the scalar (see `connector_signer::nostr`), so a
    // KMS-held identity cannot announce -- said plainly rather than
    // discovered as a panic.
    let secret = match config.signer_key() {
        SecretLocation::File(_) => read_signer_secret(config.signer_key())?,
        SecretLocation::Kms { .. } => return Err(AnnounceError::UnsignableIdentity),
    };

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

    let (amount, minimum_delivery) = amount_to_pay(config, &destination, terms.price);

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
        PacketResponse::Fulfill(fulfill) => {
            read_relay_answer(&fulfill, &shared_secret)?;
            Ok(AnnounceOutcome {
                event,
                destination,
                amount,
                sent: true,
            })
        }
        PacketResponse::Reject(reject) => Err(reject_error(&reject)),
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

    /// The greeting is read for its price and nothing else, and it must
    /// survive fields this code does not know about -- `requiredTransport`
    /// (issue #701) is on the devnet apex's own relay route today.
    #[test]
    fn terms_are_parsed_out_of_a_real_greeting_including_fields_we_ignore() {
        let body = r#"{"x402Version":2,"resource":{"url":"g.toon.relay"},
            "accepts":[{"scheme":"toon-channel","network":"g.toon.relay","amount":"1002",
            "payTo":"g.toon.relay","maxTimeoutSeconds":60,"httpEndpoint":"/ilp",
            "extra":{"ilpAddress":"g.toon.relay","endpoint":"/ilp","price":"1002",
            "requiredTransport":"btp","sessionLeaseTtlMs":300000,
            "settlement":{"chain":"evm:84532","decimals":6}}}]}"#;

        assert_eq!(
            parse_terms(body),
            Some(Terms {
                price: 1002,
                pay_to: "g.toon.relay".to_string()
            })
        );
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
}
