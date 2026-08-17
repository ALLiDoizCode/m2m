//! The port a caller *outside* [`Connector`] originates a PREPARE through
//! (issue #1020). `Connector::handle_prepare` alone answers only from this
//! connector's own configured routing table -- it cannot see a client-edge
//! session at all, because `connector-client-edge` depends on
//! `connector-runtime` and never the reverse (`session_registry.rs`). A
//! caller that wants a live session's own routing arm consulted -- the
//! operator surface's `POST /packets`, `crates/connector-operator/src/lib.rs`
//! -- cannot be handed `Connector` directly and reach it; it has to be
//! handed *something implementing this port* instead, so the crate that
//! actually holds the session registry can supply an implementation that
//! consults it, while a deployment with no client edge mounted can still
//! supply [`Connector`] itself and get exactly the old, config-table-only
//! behaviour.
//!
//! [`Connector`] itself implements this port (below) by calling
//! [`Connector::handle_prepare`] plain -- the fallback every call site used
//! before this port existed, and still correct for a caller with no session
//! registry to consult.

use async_trait::async_trait;
use connector_domain::{PacketResponse, Prepare};

use crate::connector::Connector;

/// Originate `prepare` as if this were the packet's first hop, honouring
/// `minimum_delivery` (ADR 0010) exactly as [`Connector::handle_prepare`]
/// does. See the module doc for why this exists as a port rather than a
/// plain call to [`Connector`].
#[async_trait]
pub trait PacketOriginator: Send + Sync {
    async fn originate(&self, prepare: Prepare, minimum_delivery: u64) -> PacketResponse;
}

#[async_trait]
impl PacketOriginator for Connector {
    async fn originate(&self, prepare: Prepare, minimum_delivery: u64) -> PacketResponse {
        self.handle_prepare(prepare, minimum_delivery).await
    }
}
