//! The packet plane and its ports. See ADR 0001.

mod app_client;
mod claim;
mod clock;
mod connector;
mod journal;
mod metrics;
mod operator_view;
mod outbound_client;
mod peer_transport;
mod route;
#[cfg(test)]
mod test_support;

pub use app_client::{AppClient, AppOutcome, Delivery, FakeAppClient, HttpAppClient};
pub use claim::{
    ChannelDomain, ClaimAckOutcome, ClaimBook, ClaimRejectReason, ClaimSignature, InvalidChannelId,
    InvalidSolanaChannel, SolanaChannel, WireClaim,
};
pub use clock::{Clock, SystemClock, TestClock};
pub use connector::{
    ChannelOperationError, ClientRouteFacts, ClientRouteKind, Connector, LeaseRouteError,
    ProbeDenied,
};
// Re-exported for callers that hold a `Connector` but not a config-crate
// dependency of their own (`connector-operator`): the chain key
// `Connector::with_settlement` files a settlement backend under, and
// `Connector::open_channel` names a backend by.
pub use connector_config::{SettlementChain, UnknownSettlementChain};
pub use journal::{FileJournal, InMemoryJournal, Journal, JournalError};
pub use metrics::Metrics;
pub use operator_view::{
    ChannelView, ChannelViewStatus, ClaimDirection, ClaimView, ExposureView, LeasedRouteView,
    PeerView, RouteView,
};
// The OUTBOUND client ledger (issue #873) -- what this node signs to pay a
// next hop, deliberately a different book from `ClaimBook`'s inbound
// journal above. See `outbound_client`'s header for the table of
// differences and for why the two must never merge.
pub use outbound_client::{
    ClaimStateSource, ClaimWatermark, EvmDomain, HttpClaimState, OutboundClaim,
    OutboundClientError, OutboundClientLedger,
};
pub use peer_transport::{InProcessPeerTransport, PeerForward, PeerTransport};
pub use route::{LeasedRoute, PeerRoute};
