//! `pub struct Connector` -- the packet plane. See ADR 0001.

use std::sync::Arc;

use connector_config::StaticRoute;
use connector_domain::{select_route, Fulfill, PacketResponse, Prepare, Reject, RejectCode};

use crate::app_client::{AppClient, AppOutcome};
use crate::clock::Clock;

/// The connector's packet plane: a fixed set of terminated routes, an
/// [`AppClient`] port for delivering to the apps behind them, and a
/// [`Clock`] port rather than wall time.
///
/// A router (`connector-client-edge`) deserializes a request into a
/// [`Prepare`], calls exactly one method here -- [`Connector::handle_prepare`]
/// -- and serializes the result. Every routing and delivery decision is made
/// in that one method; the router makes none.
pub struct Connector {
    routes: Vec<StaticRoute>,
    app_client: Arc<dyn AppClient>,
    clock: Arc<dyn Clock>,
}

impl Connector {
    pub fn new(
        routes: Vec<StaticRoute>,
        app_client: Arc<dyn AppClient>,
        clock: Arc<dyn Clock>,
    ) -> Connector {
        Connector {
            routes,
            app_client,
            clock,
        }
    }

    /// Route `prepare` to the app behind its matching terminated route, and
    /// translate the app's outcome into the ILP-level response a client
    /// receives.
    pub async fn handle_prepare(&self, prepare: Prepare) -> PacketResponse {
        let prefixes: Vec<&str> = self.routes.iter().map(StaticRoute::prefix).collect();

        let Some(index) = select_route(&prepare.destination, &prefixes) else {
            return PacketResponse::Reject(Reject {
                code: RejectCode::f02_unreachable(),
                triggered_by: String::new(),
                message: format!("no route to destination '{}'", prepare.destination),
                data: Vec::new(),
            });
        };

        let route = &self.routes[index];
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_client::FakeAppClient;
    use crate::clock::TestClock;
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

    fn connector_with(
        routes: Vec<StaticRoute>,
        app_client: Arc<FakeAppClient>,
        clock: Arc<TestClock>,
    ) -> Connector {
        Connector::new(routes, app_client, clock)
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
        let clock = Arc::new(TestClock::new(
            Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
        ));
        let connector = connector_with(vec![route], app_client.clone(), clock);

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello app"))
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
        let clock = Arc::new(TestClock::new(
            Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
        ));
        let connector = connector_with(vec![], app_client.clone(), clock);

        let response = connector
            .handle_prepare(prepare("g.nowhere", b"hello"))
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
        let clock = Arc::new(TestClock::new(
            Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
        ));
        let connector = connector_with(vec![route], app_client, clock);

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"))
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
        let clock = Arc::new(TestClock::new(
            Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
        ));
        let connector = connector_with(vec![route], app_client, clock);

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"))
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
            .handle_prepare(prepare("g.example.app", b"hello"))
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
        let clock = Arc::new(TestClock::new(
            Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
        ));
        let connector = connector_with(vec![general, specific.clone()], app_client.clone(), clock);

        let response = connector
            .handle_prepare(prepare("g.example.app", b"hello"))
            .await;

        assert!(matches!(response, PacketResponse::Fulfill(_)));
        assert_eq!(
            app_client.deliveries()[0].handler_url,
            *specific.handler_url()
        );
    }
}
