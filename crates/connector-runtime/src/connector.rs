//! `pub struct Connector` -- the packet plane. See ADR 0001.

use std::sync::Arc;

use connector_config::StaticRoute;
use connector_domain::{
    amount_after_fee, condition_is_present, fulfillment_matches_condition, is_expired,
    select_route, Fulfill, PacketResponse, Prepare, Reject, RejectCode,
};

use crate::app_client::{AppClient, AppOutcome};
use crate::clock::Clock;
use crate::operator_view::{ChannelView, ClaimView, ExposureView, PeerView, RouteView};
use crate::peer_transport::PeerTransport;
use crate::route::PeerRoute;

/// The connector's packet plane: a fixed set of terminated routes and peer
/// routes, an [`AppClient`] port for delivering to the apps behind
/// terminated routes, a [`PeerTransport`] port for forwarding to the next
/// hop on peer routes, and a [`Clock`] port rather than wall time.
///
/// A router (`connector-client-edge`) deserializes a request into a
/// [`Prepare`], calls exactly one method here -- [`Connector::handle_prepare`]
/// -- and serializes the result. Every routing and delivery decision is made
/// in that one method; the router makes none.
pub struct Connector {
    routes: Vec<StaticRoute>,
    peer_routes: Vec<PeerRoute>,
    app_client: Arc<dyn AppClient>,
    peer_transport: Arc<dyn PeerTransport>,
    clock: Arc<dyn Clock>,
}

impl Connector {
    pub fn new(
        routes: Vec<StaticRoute>,
        peer_routes: Vec<PeerRoute>,
        app_client: Arc<dyn AppClient>,
        peer_transport: Arc<dyn PeerTransport>,
        clock: Arc<dyn Clock>,
    ) -> Connector {
        Connector {
            routes,
            peer_routes,
            app_client,
            peer_transport,
            clock,
        }
    }

    /// Reject `prepare` outright if it isn't even eligible for routing --
    /// missing/all-zero execution condition (issue #417, no zero-condition
    /// path exists anywhere) or already past its expiry as of the injected
    /// clock, checked before any route is selected or any app/peer is
    /// touched, so an invalid or expired packet never reaches either.
    fn reject_ineligible(&self, prepare: &Prepare) -> Option<Reject> {
        if !condition_is_present(&prepare.execution_condition) {
            return Some(Reject {
                code: RejectCode::f01_invalid_packet(),
                triggered_by: String::new(),
                message: "prepare carries no execution condition".to_string(),
                data: Vec::new(),
            });
        }
        if is_expired(prepare.expires_at, self.clock.now()) {
            return Some(Reject {
                code: RejectCode::r00_transfer_timed_out(),
                triggered_by: String::new(),
                message: "prepare has expired".to_string(),
                data: Vec::new(),
            });
        }
        None
    }

    /// Reject `prepare` outright if it fails [`Self::reject_ineligible`];
    /// otherwise route it by longest-prefix match over terminated routes and
    /// peer routes together, then either deliver it to the matching app or
    /// forward it to the matching peer -- and translate whatever comes back
    /// into the ILP-level response a client receives.
    ///
    /// `minimum_delivery` is the amount the original sender declared must
    /// reach the destination (ADR 0010). Forwarding to a peer subtracts
    /// that peering relation's flat fee from `prepare.amount`; if the
    /// result would fall below `minimum_delivery`, this hop rejects
    /// (`R01_INSUFFICIENT_SOURCE_AMOUNT`) instead of forwarding a smaller
    /// amount than declared. Delivering to this connector's own app takes
    /// no fee -- a fee is earned per peering relation, not for terminating
    /// traffic at your own destination.
    pub async fn handle_prepare(&self, prepare: Prepare, minimum_delivery: u64) -> PacketResponse {
        if let Some(reject) = self.reject_ineligible(&prepare) {
            return PacketResponse::Reject(reject);
        }

        let prefixes: Vec<&str> = self
            .routes
            .iter()
            .map(StaticRoute::prefix)
            .chain(self.peer_routes.iter().map(PeerRoute::prefix))
            .collect();

        let Some(index) = select_route(&prepare.destination, &prefixes) else {
            return PacketResponse::Reject(Reject {
                code: RejectCode::f02_unreachable(),
                triggered_by: String::new(),
                message: format!("no route to destination '{}'", prepare.destination),
                data: Vec::new(),
            });
        };

        if index < self.routes.len() {
            self.deliver_to_app(&self.routes[index], prepare).await
        } else {
            let peer_route = &self.peer_routes[index - self.routes.len()];
            let condition = prepare.execution_condition;
            let response = self
                .forward_to_peer(peer_route, prepare, minimum_delivery)
                .await;
            match response {
                PacketResponse::Fulfill(fulfill) => {
                    Self::accept_if_fulfilled(&condition, Some(fulfill))
                }
                PacketResponse::Reject(_) => response,
            }
        }
    }

    async fn forward_to_peer(
        &self,
        peer_route: &PeerRoute,
        prepare: Prepare,
        minimum_delivery: u64,
    ) -> PacketResponse {
        let Some(forwarded_amount) =
            amount_after_fee(prepare.amount, peer_route.fee(), minimum_delivery)
        else {
            return PacketResponse::Reject(Reject {
                code: RejectCode::r01_insufficient_source_amount(),
                triggered_by: String::new(),
                message: format!(
                    "cannot meet minimum delivery {minimum_delivery} after this hop's fee for peer '{}'",
                    peer_route.peer_id()
                ),
                data: Vec::new(),
            });
        };

        let outgoing = Prepare {
            amount: forwarded_amount,
            ..prepare
        };
        self.peer_transport
            .forward(peer_route.peer_id(), outgoing, minimum_delivery)
            .await
    }

    async fn deliver_to_app(&self, route: &StaticRoute, prepare: Prepare) -> PacketResponse {
        let received_at = self.clock.now();
        let condition = prepare.execution_condition;
        let outcome = self
            .app_client
            .deliver(route.handler_url(), &prepare, received_at)
            .await;

        match outcome {
            AppOutcome::Delivered { data, fulfillment } => Self::accept_if_fulfilled(
                &condition,
                fulfillment.map(|fulfillment| Fulfill { fulfillment, data }),
            ),
            AppOutcome::Declined { status, body } => PacketResponse::Reject(Reject {
                code: RejectCode::f99_application_error(),
                triggered_by: String::new(),
                message: format!("app declined the delivery with HTTP {status}"),
                data: body,
            }),
            AppOutcome::Unreachable { message } => PacketResponse::Reject(Reject {
                code: RejectCode::t01_peer_unreachable(),
                triggered_by: String::new(),
                message,
                data: Vec::new(),
            }),
        }
    }

    /// This node's static routes, for the operator surface's read-only
    /// inspection interface (issue #420).
    pub fn routes(&self) -> Vec<RouteView> {
        self.routes
            .iter()
            .map(|route| RouteView {
                prefix: route.prefix().to_string(),
                handler_url: route.handler_url().to_string(),
            })
            .collect()
    }

    /// This node's peers. Always empty: no peer wire exists yet (#416).
    pub fn peers(&self) -> Vec<PeerView> {
        Vec::new()
    }

    /// This node's payment channels. Always empty: no settlement backend
    /// tracks channel state yet (#422).
    pub fn channels(&self) -> Vec<ChannelView> {
        Vec::new()
    }

    /// Claims exchanged with peers. Always empty: no claim exchange exists
    /// yet (#423).
    pub fn claims(&self) -> Vec<ClaimView> {
        Vec::new()
    }

    /// Per-peer exposure. Always empty: no exposure projection exists yet
    /// (#424).
    pub fn exposure(&self) -> Vec<ExposureView> {
        Vec::new()
    }

    /// Accept `candidate` as a genuine [`Fulfill`] only if its fulfillment
    /// verifies against `condition` (RFC-0022) -- the one check that
    /// prevents an intermediate hop (relaying a peer's answer) or a
    /// terminating one (relaying an app's) from producing a valid
    /// fulfilment without the destination's actual participation (issue
    /// #417). Anything else -- no candidate, or one that fails to verify --
    /// is a REJECT, never a fulfilment this connector invents itself.
    fn accept_if_fulfilled(condition: &[u8; 32], candidate: Option<Fulfill>) -> PacketResponse {
        match candidate {
            Some(fulfill) if fulfillment_matches_condition(condition, &fulfill.fulfillment) => {
                PacketResponse::Fulfill(fulfill)
            }
            _ => PacketResponse::Reject(Reject {
                code: RejectCode::f99_application_error(),
                triggered_by: String::new(),
                message: "fulfillment does not match execution condition".to_string(),
                data: Vec::new(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_client::FakeAppClient;
    use crate::clock::TestClock;
    use crate::peer_transport::{InProcessPeerTransport, PeerTransport};
    use async_trait::async_trait;
    use chrono::{Duration, TimeZone, Utc};
    use connector_domain::derive_condition;

    /// A fixed, non-zero preimage and the condition it derives -- used
    /// throughout so a `Delivered` outcome's fulfillment genuinely verifies
    /// against the packet's execution condition rather than the old
    /// hardcoded-zero stand-in (issue #417).
    const FULFILLMENT: [u8; 32] = [7u8; 32];

    fn condition() -> [u8; 32] {
        derive_condition(&FULFILLMENT)
    }

    fn prepare(destination: &str, data: &[u8]) -> Prepare {
        // Comfortably after `test_clock()`'s instant, so tests that don't
        // care about expiry aren't incidentally right at the boundary.
        prepare_expiring_at(
            destination,
            data,
            Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap(),
        )
    }

    fn prepare_expiring_at(
        destination: &str,
        data: &[u8],
        expires_at: chrono::DateTime<Utc>,
    ) -> Prepare {
        Prepare {
            amount: 0,
            expires_at,
            execution_condition: condition(),
            destination: destination.to_string(),
            data: data.to_vec(),
        }
    }

    fn prepare_with_amount(destination: &str, amount: u64) -> Prepare {
        Prepare {
            amount,
            ..prepare(destination, b"hello")
        }
    }

    fn test_clock() -> Arc<TestClock> {
        Arc::new(TestClock::new(
            Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
        ))
    }

    fn connector_with(
        routes: Vec<StaticRoute>,
        app_client: Arc<FakeAppClient>,
        clock: Arc<TestClock>,
    ) -> Connector {
        Connector::new(
            routes,
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            clock,
        )
    }

    #[tokio::test]
    async fn delivers_a_packet_matching_a_terminated_route() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            AppOutcome::Delivered {
                data: b"app said yes".to_vec(),
                fulfillment: Some(FULFILLMENT),
            },
        );
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client.clone(), clock);

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello app"), 0)
            .await;

        assert_eq!(
            response,
            PacketResponse::Fulfill(Fulfill {
                fulfillment: FULFILLMENT,
                data: b"app said yes".to_vec(),
            })
        );

        let deliveries = app_client.deliveries();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].data, b"hello app");
    }

    #[tokio::test]
    async fn rejects_a_packet_with_no_matching_route() {
        let app_client = Arc::new(FakeAppClient::new());
        let clock = test_clock();
        let connector = connector_with(vec![], app_client.clone(), clock);

        let response = connector
            .handle_prepare(prepare("g.nowhere", b"hello"), 0)
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "F02");
                assert!(reject.message.contains("g.nowhere"));
            }
            other => panic!("expected a reject, got {other:?}"),
        }
        assert!(app_client.deliveries().is_empty());
    }

    #[tokio::test]
    async fn rejects_a_packet_with_no_execution_condition() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client.clone(), clock);

        let mut without_condition = prepare("g.example.app", b"hello");
        without_condition.execution_condition = [0u8; 32];
        let response = connector.handle_prepare(without_condition, 0).await;

        match response {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "F01"),
            other => panic!("expected a reject, got {other:?}"),
        }
        assert!(app_client.deliveries().is_empty());
    }

    #[tokio::test]
    async fn rejects_a_packet_that_has_already_expired_and_never_delivers_it() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        let now = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
        let clock = Arc::new(TestClock::new(now));
        let connector = connector_with(vec![route], app_client.clone(), clock);
        let already_expired =
            prepare_expiring_at("g.example.app", b"hello", now - Duration::seconds(1));

        let response = connector.handle_prepare(already_expired, 0).await;

        match response {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "R00"),
            other => panic!("expected a reject, got {other:?}"),
        }
        // The in-flight record is released rather than handed to the app:
        // an expired packet never reaches delivery.
        assert!(app_client.deliveries().is_empty());
    }

    #[tokio::test]
    async fn a_packet_expires_only_once_the_injected_clock_advances_past_it() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            AppOutcome::Delivered {
                data: b"still on time".to_vec(),
                fulfillment: Some(FULFILLMENT),
            },
        );
        let start = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
        let clock = Arc::new(TestClock::new(start));
        let connector = connector_with(vec![route], app_client.clone(), clock.clone());
        let expires_at = start + Duration::seconds(30);

        let response = connector
            .handle_prepare(
                prepare_expiring_at("g.example.app", b"hello", expires_at),
                0,
            )
            .await;
        assert!(matches!(response, PacketResponse::Fulfill(_)));

        clock.advance(Duration::seconds(30));
        let response = connector
            .handle_prepare(
                prepare_expiring_at("g.example.app", b"hello", expires_at),
                0,
            )
            .await;
        match response {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "R00"),
            other => panic!("expected a reject once the clock reaches expiry, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_app_that_supplies_no_fulfillment_is_rejected_rather_than_fulfilled() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            AppOutcome::Delivered {
                data: b"app said yes".to_vec(),
                fulfillment: None,
            },
        );
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client, clock);

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "F99");
                assert!(reject.message.contains("execution condition"));
            }
            other => panic!("expected a reject, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_app_that_supplies_a_mismatching_fulfillment_is_rejected_rather_than_fulfilled() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            AppOutcome::Delivered {
                data: b"app said yes".to_vec(),
                fulfillment: Some([9u8; 32]), // does not hash to `condition()`
            },
        );
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client, clock);

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        match response {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "F99"),
            other => panic!("expected a reject, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_declining_app_produces_an_application_error_reject() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            AppOutcome::Declined {
                status: 402,
                body: b"insufficient funds".to_vec(),
            },
        );
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client, clock);

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "F99");
                assert_eq!(reject.data, b"insufficient funds");
            }
            other => panic!("expected a reject, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_unreachable_app_produces_a_peer_unreachable_reject() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        // No FakeAppClient::respond call: the fake defaults to Unreachable.
        let app_client = Arc::new(FakeAppClient::new());
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client, clock);

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        match response {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "T01"),
            other => panic!("expected a reject, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn uses_the_injected_clock_rather_than_wall_time() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            AppOutcome::Delivered {
                data: vec![],
                fulfillment: Some(FULFILLMENT),
            },
        );
        let far_future = Utc.with_ymd_and_hms(2099, 1, 1, 0, 0, 0).unwrap();
        let clock = Arc::new(TestClock::new(far_future));
        let connector = connector_with(vec![route], app_client.clone(), clock);
        let far_expiring = Utc.with_ymd_and_hms(2100, 1, 1, 0, 0, 0).unwrap();

        connector
            .handle_prepare(
                prepare_expiring_at("g.example.app", b"hello", far_expiring),
                0,
            )
            .await;

        let deliveries = app_client.deliveries();
        assert_eq!(deliveries[0].received_at, far_future);
    }

    #[tokio::test]
    async fn selects_the_most_specific_route_when_several_match() {
        let general = StaticRoute::new("g.example", "http://localhost:4000").unwrap();
        let specific = StaticRoute::new("g.example.app", "http://localhost:5000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            specific.handler_url(),
            AppOutcome::Delivered {
                data: vec![],
                fulfillment: Some(FULFILLMENT),
            },
        );
        let clock = test_clock();
        let connector = connector_with(vec![general, specific.clone()], app_client.clone(), clock);

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        assert!(matches!(response, PacketResponse::Fulfill(_)));
        assert_eq!(
            app_client.deliveries()[0].handler_url,
            *specific.handler_url()
        );
    }

    #[tokio::test]
    async fn forwards_a_packet_matching_a_peer_route_to_the_next_hop() {
        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            AppOutcome::Delivered {
                data: b"delivered by the second hop".to_vec(),
                fulfillment: Some(FULFILLMENT),
            },
        );
        let second_hop = Arc::new(Connector::new(
            vec![second_hop_route],
            vec![],
            second_hop_app_client.clone(),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let mut peer_transport = InProcessPeerTransport::new();
        peer_transport.add_peer("second-hop", second_hop);
        let first_hop = Connector::new(
            vec![],
            vec![PeerRoute::new("g.example.app", "second-hop", 0)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        );

        let response = first_hop
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        assert_eq!(
            response,
            PacketResponse::Fulfill(Fulfill {
                fulfillment: FULFILLMENT,
                data: b"delivered by the second hop".to_vec(),
            })
        );
        assert_eq!(second_hop_app_client.deliveries().len(), 1);
    }

    #[tokio::test]
    async fn forwarding_to_a_peer_subtracts_that_relations_flat_fee() {
        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            AppOutcome::Delivered {
                data: b"delivered by the second hop".to_vec(),
                fulfillment: Some(FULFILLMENT),
            },
        );
        let second_hop = Arc::new(Connector::new(
            vec![second_hop_route],
            vec![],
            second_hop_app_client.clone(),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let mut peer_transport = InProcessPeerTransport::new();
        peer_transport.add_peer("second-hop", second_hop);
        let first_hop = Connector::new(
            vec![],
            vec![PeerRoute::new("g.example.app", "second-hop", 7)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        );

        let response = first_hop
            .handle_prepare(prepare_with_amount("g.example.app", 100), 0)
            .await;

        assert!(matches!(response, PacketResponse::Fulfill(_)));
        let deliveries = second_hop_app_client.deliveries();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].amount, 93);
    }

    #[tokio::test]
    async fn a_hop_that_cannot_meet_the_minimum_delivery_after_its_fee_rejects_without_forwarding()
    {
        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            AppOutcome::Delivered {
                data: vec![],
                fulfillment: None,
            },
        );
        let second_hop = Arc::new(Connector::new(
            vec![second_hop_route],
            vec![],
            second_hop_app_client.clone(),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let mut peer_transport = InProcessPeerTransport::new();
        peer_transport.add_peer("second-hop", second_hop);
        let first_hop = Connector::new(
            vec![],
            vec![PeerRoute::new("g.example.app", "second-hop", 10)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        );

        // amount 100, fee 10 -> would forward 90, but the sender declared
        // a minimum delivery of 95: this hop must reject rather than
        // forward the smaller amount.
        let response = first_hop
            .handle_prepare(prepare_with_amount("g.example.app", 100), 95)
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "R01");
                assert!(reject.message.contains("95"));
            }
            other => panic!("expected a reject, got {other:?}"),
        }
        // Never forwarded a smaller amount hoping the far end would cope.
        assert!(second_hop_app_client.deliveries().is_empty());
    }

    #[tokio::test]
    async fn a_reject_from_the_next_hop_is_relayed_to_the_original_caller() {
        let second_hop = Arc::new(Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let mut peer_transport = InProcessPeerTransport::new();
        peer_transport.add_peer("second-hop", second_hop);
        let first_hop = Connector::new(
            vec![],
            vec![PeerRoute::new("g.example.app", "second-hop", 0)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        );

        let response = first_hop
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "F02");
                assert!(reject.message.contains("g.example.app"));
            }
            other => panic!("expected a reject, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_terminated_route_wins_over_a_shorter_peer_route() {
        let peer_route = PeerRoute::new("g.example", "second-hop", 0);
        let terminated_route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            terminated_route.handler_url(),
            AppOutcome::Delivered {
                data: b"handled locally".to_vec(),
                fulfillment: Some(FULFILLMENT),
            },
        );
        let connector = Connector::new(
            vec![terminated_route],
            vec![peer_route],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        );

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        assert_eq!(
            response,
            PacketResponse::Fulfill(Fulfill {
                fulfillment: FULFILLMENT,
                data: b"handled locally".to_vec(),
            })
        );
    }

    #[tokio::test]
    async fn a_peer_route_wins_over_a_shorter_terminated_route() {
        let terminated_route = StaticRoute::new("g.example", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        let second_hop_route = StaticRoute::new("g.example.app", "http://localhost:5000").unwrap();
        let second_hop_app_client = Arc::new(FakeAppClient::new());
        second_hop_app_client.respond(
            second_hop_route.handler_url(),
            AppOutcome::Delivered {
                data: b"handled by the second hop".to_vec(),
                fulfillment: Some(FULFILLMENT),
            },
        );
        let second_hop = Arc::new(Connector::new(
            vec![second_hop_route],
            vec![],
            second_hop_app_client.clone(),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ));
        let mut peer_transport = InProcessPeerTransport::new();
        peer_transport.add_peer("second-hop", second_hop);
        let first_hop = Connector::new(
            vec![terminated_route],
            vec![PeerRoute::new("g.example.app", "second-hop", 0)],
            app_client,
            Arc::new(peer_transport),
            test_clock(),
        );

        let response = first_hop
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        assert_eq!(
            response,
            PacketResponse::Fulfill(Fulfill {
                fulfillment: FULFILLMENT,
                data: b"handled by the second hop".to_vec(),
            })
        );
        assert_eq!(second_hop_app_client.deliveries().len(), 1);
    }

    #[test]
    fn routes_reports_every_configured_static_route() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        let clock = test_clock();
        let connector = connector_with(vec![route], app_client, clock);

        let routes = connector.routes();

        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].prefix, "g.example.app");
        assert_eq!(routes[0].handler_url, "http://localhost:4000/");
    }

    #[test]
    fn peers_channels_claims_and_exposure_are_empty_until_their_tickets_land() {
        let app_client = Arc::new(FakeAppClient::new());
        let clock = test_clock();
        let connector = connector_with(vec![], app_client, clock);

        assert!(connector.peers().is_empty());
        assert!(connector.channels().is_empty());
        assert!(connector.claims().is_empty());
        assert!(connector.exposure().is_empty());
    }

    /// A peer that answers with a fulfillment not matching the packet's
    /// execution condition cannot get its answer relayed as-is: an
    /// intermediate hop must verify a downstream fulfilment rather than
    /// trust it, per issue #417's "cannot produce a valid fulfilment
    /// without the destination's participation."
    struct FixedResponsePeerTransport(PacketResponse);

    #[async_trait]
    impl PeerTransport for FixedResponsePeerTransport {
        async fn forward(
            &self,
            _peer_id: &str,
            _prepare: Prepare,
            _minimum_delivery: u64,
        ) -> PacketResponse {
            self.0.clone()
        }
    }

    #[tokio::test]
    async fn a_fulfillment_from_a_peer_that_does_not_match_the_execution_condition_is_rejected() {
        let bogus_fulfillment = [9u8; 32]; // does not hash to `condition()`
        let peer_transport = FixedResponsePeerTransport(PacketResponse::Fulfill(Fulfill {
            fulfillment: bogus_fulfillment,
            data: b"claimed delivery".to_vec(),
        }));
        let connector = Connector::new(
            vec![],
            vec![PeerRoute::new("g.example.app", "second-hop", 0)],
            Arc::new(FakeAppClient::new()),
            Arc::new(peer_transport),
            test_clock(),
        );

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
            .await;

        match response {
            PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "F99"),
            other => panic!("expected a reject, got {other:?}"),
        }
    }
}
