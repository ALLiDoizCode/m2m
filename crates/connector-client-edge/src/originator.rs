//! Issue #1020: the operator surface's `POST /packets`
//! (`crates/connector-operator/src/lib.rs`, `originate_packet`) used to call
//! `connector_runtime::Connector::handle_prepare` directly, which cannot see
//! a live client-edge session at all -- `connector-client-edge` depends on
//! `connector-runtime`, never the reverse (`session_registry.rs`). So a
//! destination bound only in [`crate::session_registry::SessionRegistry`]
//! resolved differently depending on which door a PREPARE came through:
//! delivered through `POST /ilp` or the BTP carriage, `F02` through
//! `POST /packets`.
//!
//! [`SessionAwareOriginator`] is the fix: it wraps the same
//! [`ClientEdgeState`] this crate's own router is mounted over and
//! implements [`PacketOriginator`] by calling
//! [`crate::session_route::route_prepare`] -- the exact routing arm `POST
//! /ilp`/the BTP carriage already use -- so a node that hands this to
//! `connector_operator::router_with_originator` gets the session arm
//! consulted from the operator surface too, against the very same session
//! registry a client dialled into.

use std::sync::Arc;

use async_trait::async_trait;
use connector_domain::{PacketResponse, Prepare};
use connector_runtime::PacketOriginator;

use crate::session_route::route_prepare;
use crate::ClientEdgeState;

/// See the module doc. `price` is always `0` at this call site -- unlike
/// `POST /ilp`/the BTP carriage, an operator-originated packet was never
/// matched against `Connector::app_route` before this point, so there is no
/// figure to price a mismatched fulfilment against (the same reasoning
/// `originate_packet`'s own history has: it never computed one either).
/// `client_channel_id` is always `None`: an operator write is authenticated
/// by its RFC 9421 signature, never by a covering claim.
pub struct SessionAwareOriginator(pub(crate) Arc<ClientEdgeState>);

#[async_trait]
impl PacketOriginator for SessionAwareOriginator {
    async fn originate(&self, prepare: Prepare, minimum_delivery: u64) -> PacketResponse {
        route_prepare(&self.0, prepare, 0, minimum_delivery, None).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use connector_btp::{decode_frame, BtpFrame, BtpSessionHandle, OutboundRequests, BTP_RESPONSE};
    use connector_domain::{derive_condition, Fulfill};
    use connector_runtime::{
        Connector, FakeAppClient, InMemoryJournal, InProcessPeerTransport, TestClock,
    };
    use connector_signer::{LocalSigner, Signer};
    use tokio::sync::mpsc;

    use crate::session_registry::SessionRegistry;
    use crate::ClientClaimGate;

    const FULFILLMENT: [u8; 32] = [3u8; 32];

    fn test_clock() -> Arc<TestClock> {
        Arc::new(TestClock::new(
            Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
        ))
    }

    /// Issue #1020's own regression: [`SessionAwareOriginator::originate`]
    /// must reach a destination bound only in [`SessionRegistry`] -- the
    /// exact shape `Connector::handle_prepare` alone cannot see (no route
    /// matches `"g.client.one"`, so a plain [`Connector`] would answer
    /// `F02` for it), and the whole reason this type exists rather than
    /// `connector-operator` calling `Connector::handle_prepare` directly.
    #[tokio::test]
    async fn originate_reaches_a_destination_bound_only_in_the_session_registry() {
        let connector = Arc::new(Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));

        let registry = SessionRegistry::new();
        let (replies, mut reply_rx) = mpsc::channel::<Vec<u8>>(4);
        let outbound = Arc::new(OutboundRequests::new());
        let handle = BtpSessionHandle::new(replies, Arc::clone(&outbound));
        registry.bind("g.client.one", handle, crate::now_unix());

        let state = Arc::new(ClientEdgeState {
            connector,
            signer: Arc::new(LocalSigner::generate("originator-test")) as Arc<dyn Signer>,
            claim_gate: Arc::new(
                ClientClaimGate::restore(Default::default(), Arc::new(InMemoryJournal::new()))
                    .expect("a fresh in-memory journal has nothing to replay"),
            ),
            wrap_receiver_secret: None,
            settlement_terms: None,
            settlements: Vec::new(),
            btp_session_window: crate::DEFAULT_BTP_SESSION_WINDOW,
            session_registry: Arc::new(registry),
            peers: None,
            bootstrap_identity: None,
            identities: Arc::from([]),
        });
        let originator = SessionAwareOriginator(state);

        let condition = derive_condition(&FULFILLMENT);
        let prepare = Prepare {
            amount: 0,
            expires_at: Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap(),
            execution_condition: condition,
            destination: "g.client.one".to_string(),
            data: Vec::new(),
        };

        let peer = tokio::spawn(async move {
            let sent = reply_rx.recv().await.expect("the MESSAGE was written");
            let decoded = decode_frame(&sent).expect("the connector's own encoder");
            outbound.resolve(BtpFrame {
                frame_type: BTP_RESPONSE,
                request_id: decoded.request_id,
                amount: None,
                protocol_data: Vec::new(),
                ilp_packet: Fulfill {
                    fulfillment: FULFILLMENT,
                    data: Vec::new(),
                }
                .encode(),
            });
        });

        let response = originator.originate(prepare, 0).await;
        peer.await.expect("the peer task");

        assert!(
            matches!(response, PacketResponse::Fulfill(fulfill) if fulfill.fulfillment == FULFILLMENT),
            "a destination bound only in the session registry must be reachable through \
             PacketOriginator::originate, exactly as POST /ilp/the BTP carriage already reach it"
        );
    }
}
