//! Pure domain logic: no async, no I/O. See ADR 0001.
//!
//! ILPv4 packet types (RFC-0027) with their OER wire encoding (RFC-0030),
//! ILP address validation (RFC-0015), longest-prefix route selection, and
//! flat per-packet fee / minimum-delivery arithmetic (ADR 0010).

mod address;
mod error;
mod fee;
mod oer;
mod packet;
mod route;

pub use address::is_valid_ilp_address;
pub use error::PacketError;
pub use fee::amount_after_fee;
pub use packet::{Fulfill, PacketResponse, Prepare, Reject, RejectCode};
pub use route::select_route;
