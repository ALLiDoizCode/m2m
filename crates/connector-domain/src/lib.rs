//! Pure domain logic: no async, no I/O. See ADR 0001.
//!
//! ILPv4 packet types (RFC-0027) with their OER wire encoding (RFC-0030),
//! ILP address validation (RFC-0015), and longest-prefix route selection.

mod address;
mod error;
mod oer;
mod packet;
mod route;

pub use address::is_valid_ilp_address;
pub use error::PacketError;
pub use packet::{Fulfill, PacketResponse, Prepare, Reject, RejectCode};
pub use route::select_route;
