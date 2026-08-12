//! Read models for the operator surface (issue #420, ADR 0008). Each type
//! here is exactly what [`crate::Connector`] hands back to a read handler --
//! no method beyond what the handler serializes as-is.
//!
//! [`ChannelView`] gained real fields in #459, once a settlement backend
//! existed for [`Connector`] to project channel state from. [`ClaimView`]
//! gained real fields in #423, once `crate::claim::ClaimBook` existed to
//! report on. [`PeerView`] gained its first field in #884, once
//! [`Connector`] gained a runtime-mutable peer table to report on --
//! before that it was a literal empty struct, since nothing in the
//! runtime tracked peer identity at all (peer carriage credentials live
//! entirely in `connector_config::PeerConfig`, consumed once at boot and
//! never stored back on [`Connector`]). An `ExposureView` existed from
//! #424 until ADR 0031/ADR 0033 (issue #882) retired the credit-window
//! accounting it reported.

use chrono::{DateTime, Utc};
use connector_settlement::{ChannelState, ChannelStatus};
use serde::{Deserialize, Serialize};

/// Whether a peer or route row came from the config file, loaded once at
/// boot and immutable for the process's life, or was added at runtime
/// over the operator surface (issue #884) -- durable, but never able to
/// shadow or be shadowed by a config-file row of the same key. See
/// `docs/adr/0034-a-runtime-peer-route-table-never-shadows-the-config-file.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RouteSource {
    Config,
    Runtime,
}

/// A static route as seen by the operator surface. `price` is the flat
/// per-packet amount a claim must advance by to pay for this route (issue
/// #520) -- always present, since a terminated route is never silently
/// free.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteView {
    pub prefix: String,
    pub handler_url: String,
    pub price: u64,
}

/// A leased route (issue #427) as seen by the operator surface -- only
/// ever one not yet lapsed as of this node's own clock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeasedRouteView {
    pub prefix: String,
    pub peer_id: String,
    pub fee: u64,
    pub expires_at: DateTime<Utc>,
}

/// A peer as seen by the operator surface (issue #884): every peer id this
/// node knows, from the config file (`source: Config`) or added at
/// runtime over the operator surface (`source: Runtime`). Peer carriage
/// details -- endpoint, credential, exposure -- stay in
/// `connector_config::PeerConfig` and are not reported here; this is only
/// the identity a `peer_id` on a route resolves against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerView {
    pub id: String,
    pub source: RouteSource,
}

/// A peer-forwarding route (as opposed to [`RouteView`]'s app-terminating
/// one) as seen by the operator surface (issue #884): every row from
/// `[[routes]]`'s peer form (`source: Config`) plus every row added at
/// runtime (`source: Runtime`). Deliberately excludes a leased route
/// (issue #427) -- [`LeasedRouteView`] already reports those, and a lease
/// carries no `price` at all, unlike either of these.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerRouteView {
    pub prefix: String,
    pub peer_id: String,
    pub fee: u64,
    pub price: u64,
    pub source: RouteSource,
}

/// A payment channel as seen by the operator surface (issue #459).
/// `counterparty` is hex-encoded (`0x`-prefixed) since it is arbitrary
/// bytes, not necessarily UTF-8 -- an EVM backend's is a 20-byte address,
/// but the port itself (`connector_settlement::SettlementBackend::open`)
/// takes an opaque `Vec<u8>`, so this view makes no assumption about its
/// shape beyond "some bytes, safe to put in JSON".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelView {
    pub id: String,
    pub counterparty: String,
    pub status: ChannelViewStatus,
    pub deposited: u128,
    pub redeemed: u128,
}

/// A channel's lifecycle status as reported over the operator surface --
/// mirrors [`connector_settlement::ChannelStatus`] rather than reusing it
/// directly, so this crate's read models stay serializable without
/// requiring that of every port type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelViewStatus {
    Open,
    /// Closed: its challenge period is running (or has elapsed but not yet
    /// been settled) -- `redeem` still works against it (issue #574).
    Closed,
    /// Settled: terminal, no further `fund` or `redeem` is possible.
    Settled,
}

impl From<ChannelState> for ChannelView {
    fn from(state: ChannelState) -> Self {
        ChannelView {
            id: state.id.0,
            counterparty: encode_hex(&state.counterparty),
            status: match state.status {
                ChannelStatus::Open => ChannelViewStatus::Open,
                ChannelStatus::Closed => ChannelViewStatus::Closed,
                ChannelStatus::Settled => ChannelViewStatus::Settled,
            },
            deposited: state.deposited,
            redeemed: state.redeemed,
        }
    }
}

/// `0x`-prefixed lowercase hex -- the one encoding this crate uses whenever
/// arbitrary bytes need to round-trip through JSON.
fn encode_hex(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(2 + bytes.len() * 2);
    hex.push_str("0x");
    for byte in bytes {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// A claim as seen by the operator surface (issue #423): one entry per
/// direction per peering relation with a claim ever exchanged -- what this
/// connector has claimed to the peer ([`ClaimDirection::Outbound`]) and
/// what the peer has claimed to this connector
/// ([`ClaimDirection::Inbound`], i.e. this connector's own watermark on
/// that channel). `peer_id` is `None` on an inbound entry: the peer wire
/// has no identity handshake yet, so an inbound claim is known only by the
/// channel it names, not by which configured peer sent it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaimView {
    pub peer_id: Option<String>,
    pub channel_id: String,
    pub direction: ClaimDirection,
    pub nonce: u64,
    pub cumulative_amount: u64,
    /// `true` for an outbound claim not yet acknowledged by the peer --
    /// always `false` for an inbound claim, which is accepted or rejected
    /// the instant it is received, never left pending.
    pub pending: bool,
}

/// Which side of a peering relation a [`ClaimView`] reports on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaimDirection {
    Outbound,
    Inbound,
}
