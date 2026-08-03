//! The packet plane and its ports. See ADR 0001.

mod app_client;
mod claim;
mod clock;
mod connector;
mod journal;
mod metrics;
mod network_peer_transport;
mod operator_view;
mod peer_transport;
mod peer_wire;
mod route;
#[cfg(test)]
mod test_support;

pub use app_client::{AppClient, AppOutcome, Delivery, FakeAppClient, HttpAppClient};
pub use claim::{
    ChannelDomain, ClaimAckOutcome, ClaimBook, ClaimRejectReason, InvalidChannelId, WireClaim,
};
pub use clock::{Clock, SystemClock, TestClock};
pub use connector::{
    AppRouteFacts, ChannelOperationError, Connector, LeaseRouteError, ProbeDenied,
};
// Re-exported for callers that hold a `Connector` but not a config-crate
// dependency of their own (`connector-operator`): the chain key
// `Connector::with_settlement` files a settlement backend under, and
// `Connector::open_channel` names a backend by.
pub use connector_config::{SettlementChain, UnknownSettlementChain};
pub use journal::{FileJournal, InMemoryJournal, Journal, JournalError};
pub use metrics::Metrics;
pub use network_peer_transport::{NetworkPeerTransport, PeerWireServer};
pub use operator_view::{
    ChannelView, ChannelViewStatus, ClaimDirection, ClaimView, ExposureView, LeasedRouteView,
    PeerView, RouteView,
};
pub use peer_transport::{InProcessPeerTransport, PeerTransport};
pub use route::{LeasedRoute, PeerRoute};
