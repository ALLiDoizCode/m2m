//! Pure domain logic: no async, no I/O. See ADR 0001.
//!
//! ILPv4 packet types (RFC-0027) with their OER wire encoding (RFC-0030),
//! ILP address validation (RFC-0015), longest-prefix route selection,
//! flat per-packet fee / minimum-delivery arithmetic (ADR 0010),
//! execution condition / fulfilment / expiry rules (RFC-0022, issue #417),
//! and claim nonce / watermark rules (ADR 0004, ADR 0005, issue #423).

mod address;
mod claim;
mod condition;
mod error;
mod fee;
mod oer;
mod packet;
mod projection;
mod route;

pub use address::is_valid_ilp_address;
pub use claim::{
    advance_watermark, claim_digest, validate_claim, validate_price, ClaimError, Watermark,
};
pub use condition::{
    condition_is_present, derive_condition, fulfillment_matches_condition, is_expired,
};
pub use error::PacketError;
pub use fee::amount_after_fee;
pub use packet::{Fulfill, PacketResponse, Prepare, Reject, RejectCode};
pub use projection::{JournalEntry, Projection, ProjectionDivergence};
pub use route::select_route;
