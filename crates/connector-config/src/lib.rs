//! Configuration: one typed file, fully validated at boot, held as an
//! immutable value for the process lifetime. See ADR 0001, ADR 0009.
//!
//! There is no environment-variable override layer -- [`Config::load`] reads
//! exactly one file, so there is exactly one place any value comes from.
//! Convenience forms (`[[children]]`) are desugared here, so the rest of the
//! connector only ever sees ordinary [`StaticRoute`]s. Key material is never
//! read into this crate; a [`SecretLocation`] is a pointer (a file path or a
//! KMS identifier), validated for presence but not for content.
//!
//! The one exception is a peering's shared secret, which is compared against
//! on every arriving frame rather than handed to a signer: [`PeerCredential`]
//! holds the secret itself, whether it was written as a literal or read from
//! `credential.secret_file` at load (issue #750). It is read here so an
//! unreadable file is a refuse-to-start error (ADR 0009) instead of a peering
//! that silently never establishes, and neither it nor the raw config value it
//! passed through renders in a [`std::fmt::Debug`].

mod announce;
mod client_channel;
mod config;
mod error;
mod operator;
mod peer;
mod peer_channel;
mod route;
mod secret;
mod settlement;

pub use announce::AnnounceConfig;
pub use client_channel::{ClientChannelConfig, EvmClientChannelConfig, SolanaClientChannelConfig};
pub use config::Config;
pub use error::ConfigError;
pub use operator::OperatorConfig;
pub use peer::{PeerCarriage, PeerConfig, PeerCredential, PeerExposure};
pub use peer_channel::{EvmPeerChannelConfig, PeerChannelConfig, SolanaPeerChannelConfig};
pub use route::{PeerRouteConfig, StaticRoute, TransportPolicy};
pub use secret::SecretLocation;
pub use settlement::{
    EvmSettlementConfig, SettlementChain, SettlementConfig, SolanaSettlementConfig,
    UnknownSettlementChain,
};
