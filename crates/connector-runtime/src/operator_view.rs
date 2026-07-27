//! Read models for the operator surface (issue #420, ADR 0008). Each type
//! here is exactly what [`crate::Connector`] hands back to a read handler --
//! no method beyond what the handler serializes as-is.
//!
//! [`PeerView`] has no fields yet because nothing in the runtime tracks
//! that state yet: the peer wire (#416) hasn't landed. [`ChannelView`]
//! gained real fields in #459, once a settlement backend existed for
//! [`Connector`] to project channel state from. [`ClaimView`] gained real
//! fields in #423, once `crate::claim::ClaimBook` existed to report on.
//! [`ExposureView`] gained real fields in #424, once the exposure
//! projection existed. [`Connector`]'s accessor for the still-empty
//! [`PeerView`] returns an empty list until #416 lands; the operator
//! surface is already complete as an interface; that ticket only needs to
//! start populating it.

use chrono::{DateTime, Utc};
use connector_settlement::{ChannelState, ChannelStatus};
use serde::{Deserialize, Serialize};

/// A static route as seen by the operator surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteView {
    pub prefix: String,
    pub handler_url: String,
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

/// A peer as seen by the operator surface. See the module docs: always
/// empty until #416 (the peer wire) lands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerView {}

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
    Closed,
}

impl From<ChannelState> for ChannelView {
    fn from(state: ChannelState) -> Self {
        ChannelView {
            id: state.id.0,
            counterparty: encode_hex(&state.counterparty),
            status: match state.status {
                ChannelStatus::Open => ChannelViewStatus::Open,
                ChannelStatus::Closed => ChannelViewStatus::Closed,
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

/// A channel's exposure as seen by the operator surface (issue #424): value
/// this connector has delivered on that channel's counterparty's behalf but
/// does not yet hold a covering claim for. `ceiling` is `None` for a
/// channel with no configured ceiling -- reported (never forwarding stops
/// for it), but never `over_ceiling`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExposureView {
    pub channel_id: String,
    pub exposure: u64,
    pub ceiling: Option<u64>,
    pub over_ceiling: bool,
}
