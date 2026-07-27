//! Library half of the `connector` package. `main.rs` (the `connector`
//! binary) and `bin/stub_app.rs` don't use this at all -- it exists solely
//! to back `bin/fleet_compare.rs` and let `tests/` drive that logic
//! directly rather than only through the compiled binary.

pub mod fleet_compare;
