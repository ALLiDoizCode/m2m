//! `pub struct Connector` -- the packet plane. See ADR 0001.

use std::sync::Arc;

use connector_config::StaticRoute;
use connector_domain::{
    amount_after_fee, select_route, Fulfill, PacketResponse, Prepare, Reject, RejectCode,
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

    /// Route `prepare` by longest-prefix match over terminated routes and
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
            self.forward_to_peer(peer_route, prepare, minimum_delivery)
                .await
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
        let outcome = self
            .app_client
            .deliver(route.handler_url(), &prepare, received_at)
            .await;

        match outcome {
            AppOutcome::Delivered { data } => PacketResponse::Fulfill(Fulfill {
                fulfillment: [0u8; 32],
                data,
            }),
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_client::FakeAppClient;
    use crate::clock::TestClock;
    use crate::peer_transport::InProcessPeerTransport;
    use chrono::{TimeZone, Utc};

    fn prepare(destination: &str, data: &[u8]) -> Prepare {
        Prepare {
            amount: 0,
            expires_at: Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
            execution_condition: [0u8; 32],
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
                fulfillment: [0u8; 32],
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
        app_client.respond(route.handler_url(), AppOutcome::Delivered { data: vec![] });
        let far_future = Utc.with_ymd_and_hms(2099, 1, 1, 0, 0, 0).unwrap();
        let clock = Arc::new(TestClock::new(far_future));
        let connector = connector_with(vec![route], app_client.clone(), clock);

        connector
            .handle_prepare(prepare("g.example.app", b"hello"), 0)
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
            AppOutcome::Delivered { data: vec![] },
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
                fulfillment: [0u8; 32],
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
            AppOutcome::Delivered { data: vec![] },
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
                fulfillment: [0u8; 32],
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
                fulfillment: [0u8; 32],
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
}
