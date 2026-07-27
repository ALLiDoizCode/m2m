//! Configuration: one typed file, fully validated at boot, held as an
//! immutable value for the process lifetime. See ADR 0001, ADR 0009.
//!
//! There is no environment-variable override layer -- [`Config::load`] reads
//! exactly one file, so there is exactly one place any value comes from.
//! Convenience forms (`[[children]]`) are desugared here, so the rest of the
//! connector only ever sees ordinary [`StaticRoute`]s. Secrets are never
//! read into this crate; a [`SecretLocation`] is a pointer (a file path or a
//! KMS identifier), validated for presence but not for content.

mod config;
mod error;
mod operator;
mod peer;
mod route;
mod secret;

pub use config::Config;
pub use error::ConfigError;
pub use operator::OperatorConfig;
pub use peer::PeerConfig;
pub use route::{PeerRouteConfig, StaticRoute};
pub use secret::SecretLocation;
