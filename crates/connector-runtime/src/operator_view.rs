//! Read models for the operator surface (issue #420, ADR 0008). Each type
//! here is exactly what [`crate::Connector`] hands back to a read handler --
//! no method beyond what the handler serializes as-is.
//!
//! [`PeerView`], [`ChannelView`], [`ClaimView`] and [`ExposureView`] have no
//! fields yet because nothing in the runtime tracks that state yet: the peer
//! wire (#416), the EVM settlement backend (#422), claim exchange (#423) and
//! the exposure projection (#424) haven't landed. [`Connector`]'s accessors
//! for them return an empty list until each lands; the operator surface is
//! already complete as an interface; the tickets above only need to start
//! populating it.

use serde::{Deserialize, Serialize};

/// A static route as seen by the operator surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteView {
    pub prefix: String,
    pub handler_url: String,
}

/// A peer as seen by the operator surface. See the module docs: always
/// empty until #416 (the peer wire) lands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerView {}

/// A payment channel as seen by the operator surface. See the module docs:
/// always empty until #422 (the EVM settlement backend) lands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelView {}

/// A claim as seen by the operator surface. See the module docs: always
/// empty until #423 (claim exchange) lands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaimView {}

/// A peering relation's exposure as seen by the operator surface. See the
/// module docs: always empty until #424 (the exposure projection) lands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExposureView {}
