//! Pure domain logic: no async, no I/O. See ADR 0001.
//!
//! ILPv4 packet types (RFC-0027) with their OER wire encoding (RFC-0030),
//! ILP address validation (RFC-0015), longest-prefix route selection,
//! flat per-packet fee / minimum-delivery arithmetic (ADR 0010),
//! execution condition / fulfilment / expiry rules (RFC-0022, issue #417),
//! claim nonce / watermark rules (ADR 0004, ADR 0005, issue #423), and the
//! envelope codec for a locally-terminated route's HTTP request/response
//! (`docs/protocol/client-edge-spec.md` §1.7, issue #501).

mod address;
mod claim;
mod condition;
mod envelope;
mod error;
mod fee;
mod oer;
mod packet;
mod projection;
mod route;

pub use address::is_valid_ilp_address;
pub use claim::{advance_watermark, claim_digest, validate_claim, ClaimError, Watermark};
pub use condition::{
    condition_is_present, derive_condition, fulfillment_matches_condition, is_expired,
};
pub use envelope::{
    decode_request, encode_request, encode_response, EnvelopeError, HttpRequestEnvelope,
    HttpResponseEnvelope,
};
pub use error::PacketError;
pub use fee::amount_after_fee;
pub use packet::{Fulfill, PacketResponse, Prepare, Reject, RejectCode};
pub use projection::{JournalEntry, Projection, ProjectionDivergence};
pub use route::select_route;
