//! Pure domain logic: no async, no I/O. See ADR 0001.
//!
//! ILPv4 packet types (RFC-0027) with their OER wire encoding (RFC-0030),
//! ILP address validation (RFC-0015), longest-prefix route selection,
//! flat per-packet fee arithmetic (ADR 0010),
//! execution condition / fulfilment / expiry rules (RFC-0022, issue #417),
//! claim nonce / watermark rules (ADR 0004, ADR 0005, issue #423), and the
//! structured envelope a packet carries to and from the app behind a
//! terminated route (ADR 0018, issue #519). Also the x402 `payment-required`
//! greeting's wire shape and its reader (issue #874, [`x402`]) -- shared here
//! because the crate that writes one and the crates that read one sit on
//! opposite sides of the graph and must not each own a definition of it.

mod address;
mod claim;
pub mod client_claim;
mod condition;
mod envelope;
mod error;
mod fee;
pub mod identity;
mod oer;
mod packet;
mod projection;
mod route;
pub mod x402;

pub use address::is_valid_ilp_address;
pub use claim::{advance_watermark, validate_claim, validate_price, ClaimError, Watermark};
pub use condition::{
    condition_is_present, derive_condition, fulfillment_matches_condition, is_expired,
};
pub use envelope::{EnvelopeError, EnvelopeRequest, EnvelopeResponse};
pub use error::PacketError;
pub use fee::amount_after_fee;
pub use identity::{
    anonymous_identity, resolve_identity, ConfiguredIdentity, SenderIdentity, UnauthorizedIdentity,
};
pub use packet::{Fulfill, PacketResponse, Prepare, Reject, RejectCode};
pub use projection::{JournalEntry, Projection};
pub use route::select_route;
