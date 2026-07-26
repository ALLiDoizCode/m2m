//! The port between this connector and the app behind a terminated route.
//! The app is payment-oblivious: it is handed a delivery over plain HTTP and
//! returns success or failure, knowing nothing about channels or claims.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use url::Url;

use connector_domain::Prepare;

/// What delivering a [`Prepare`] to an app produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppOutcome {
    /// The app accepted the delivery (an HTTP 2xx response). `fulfillment`
    /// is the app's claimed preimage for the packet's execution condition --
    /// present only when the app supplied one (the `TOON-Fulfillment`
    /// response header, RFC-0022) -- and is `None` on a 2xx response that
    /// carries no such header. Either way this is only ever the app's claim:
    /// [`crate::Connector`] verifies it against the condition (issue #417)
    /// before treating the packet as fulfilled, so an app cannot forge a
    /// fulfilment and neither can this connector on its behalf.
    Delivered {
        data: Vec<u8>,
        fulfillment: Option<[u8; 32]>,
    },
    /// The app declined the delivery (a non-2xx HTTP response).
    Declined { status: u16, body: Vec<u8> },
    /// The app could not be reached at all (connection failure, timeout).
    Unreachable { message: String },
}

const FULFILLMENT_HEADER: &str = "TOON-Fulfillment";

/// Decode a lowercase-or-uppercase 64-character hex string into 32 bytes.
/// Any malformed value (wrong length, non-hex characters) is treated the
/// same as an absent header -- both leave `fulfillment` as `None`.
fn decode_fulfillment_header(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(value.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// Delivers a [`Prepare`] to the app behind a terminated route over HTTP.
#[async_trait]
pub trait AppClient: Send + Sync {
    async fn deliver(
        &self,
        handler_url: &Url,
        prepare: &Prepare,
        received_at: DateTime<Utc>,
    ) -> AppOutcome;
}

/// The production [`AppClient`]: a reverse proxy over plain HTTP. The
/// packet's opaque `data` becomes the request body; the app's status code
/// decides [`AppOutcome`] -- any 2xx is delivered, anything else is
/// declined -- and a 2xx response's `TOON-Fulfillment` header (issue #417),
/// if present and well-formed, becomes the delivery's claimed fulfillment.
pub struct HttpAppClient {
    client: reqwest::Client,
}

impl HttpAppClient {
    pub fn new() -> HttpAppClient {
        HttpAppClient {
            client: reqwest::Client::new(),
        }
    }
}

impl Default for HttpAppClient {
    fn default() -> Self {
        HttpAppClient::new()
    }
}

#[async_trait]
impl AppClient for HttpAppClient {
    async fn deliver(
        &self,
        handler_url: &Url,
        prepare: &Prepare,
        received_at: DateTime<Utc>,
    ) -> AppOutcome {
        let response = self
            .client
            .post(handler_url.clone())
            .header("TOON-Received-At", received_at.to_rfc3339())
            .body(prepare.data.clone())
            .send()
            .await;

        match response {
            Ok(response) => {
                let status = response.status();
                let fulfillment = response
                    .headers()
                    .get(FULFILLMENT_HEADER)
                    .and_then(|value| value.to_str().ok())
                    .and_then(decode_fulfillment_header);
                let body = response
                    .bytes()
                    .await
                    .map(|bytes| bytes.to_vec())
                    .unwrap_or_default();
                if status.is_success() {
                    AppOutcome::Delivered {
                        data: body,
                        fulfillment,
                    }
                } else {
                    AppOutcome::Declined {
                        status: status.as_u16(),
                        body,
                    }
                }
            }
            Err(source) => AppOutcome::Unreachable {
                message: source.to_string(),
            },
        }
    }
}

/// A real in-memory [`AppClient`]: no socket, no process, but genuinely
/// upholds the port's contract (ADR 0007) -- callers configure the outcome
/// each `handler_url` produces, and every delivery is recorded so a test can
/// assert on exactly what was sent.
#[derive(Default)]
pub struct FakeAppClient {
    responses: Mutex<HashMap<String, AppOutcome>>,
    deliveries: Mutex<Vec<Delivery>>,
}

/// One recorded call into a [`FakeAppClient`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivery {
    pub handler_url: Url,
    pub amount: u64,
    pub data: Vec<u8>,
    pub received_at: DateTime<Utc>,
}

impl FakeAppClient {
    pub fn new() -> FakeAppClient {
        FakeAppClient::default()
    }

    /// Configure the outcome a future delivery to `handler_url` produces.
    pub fn respond(&self, handler_url: &Url, outcome: AppOutcome) {
        self.responses
            .lock()
            .expect("responses lock")
            .insert(handler_url.to_string(), outcome);
    }

    /// Every delivery this fake has received, in order.
    pub fn deliveries(&self) -> Vec<Delivery> {
        self.deliveries.lock().expect("deliveries lock").clone()
    }
}

#[async_trait]
impl AppClient for FakeAppClient {
    async fn deliver(
        &self,
        handler_url: &Url,
        prepare: &Prepare,
        received_at: DateTime<Utc>,
    ) -> AppOutcome {
        self.deliveries
            .lock()
            .expect("deliveries lock")
            .push(Delivery {
                handler_url: handler_url.clone(),
                amount: prepare.amount,
                data: prepare.data.clone(),
                received_at,
            });

        self.responses
            .lock()
            .expect("responses lock")
            .get(handler_url.as_str())
            .cloned()
            .unwrap_or(AppOutcome::Unreachable {
                message: format!("no fake response configured for {handler_url}"),
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn prepare(destination: &str, data: &[u8]) -> Prepare {
        Prepare {
            amount: 0,
            expires_at: Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
            execution_condition: [0u8; 32],
            destination: destination.to_string(),
            data: data.to_vec(),
        }
    }

    #[tokio::test]
    async fn fake_app_client_returns_the_configured_outcome() {
        let fake = FakeAppClient::new();
        let handler_url = Url::parse("http://localhost:4000").unwrap();
        fake.respond(
            &handler_url,
            AppOutcome::Delivered {
                data: b"ok".to_vec(),
                fulfillment: Some([7u8; 32]),
            },
        );

        let received_at = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
        let outcome = fake
            .deliver(
                &handler_url,
                &prepare("g.example.app", b"hello"),
                received_at,
            )
            .await;

        assert_eq!(
            outcome,
            AppOutcome::Delivered {
                data: b"ok".to_vec(),
                fulfillment: Some([7u8; 32]),
            }
        );
    }

    #[tokio::test]
    async fn fake_app_client_records_every_delivery() {
        let fake = FakeAppClient::new();
        let handler_url = Url::parse("http://localhost:4000").unwrap();
        let received_at = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();

        fake.deliver(
            &handler_url,
            &prepare("g.example.app", b"hello"),
            received_at,
        )
        .await;

        let deliveries = fake.deliveries();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].handler_url, handler_url);
        assert_eq!(deliveries[0].data, b"hello");
        assert_eq!(deliveries[0].received_at, received_at);
    }

    #[tokio::test]
    async fn fake_app_client_defaults_to_unreachable_when_unconfigured() {
        let fake = FakeAppClient::new();
        let handler_url = Url::parse("http://localhost:4000").unwrap();
        let received_at = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();

        let outcome = fake
            .deliver(
                &handler_url,
                &prepare("g.example.app", b"hello"),
                received_at,
            )
            .await;

        assert!(matches!(outcome, AppOutcome::Unreachable { .. }));
    }

    /// Contract suite (ADR 0007): both [`AppClient`] implementations honor
    /// the same statement -- a 2xx handler produces `Delivered` carrying the
    /// response body, and a non-2xx handler produces `Declined` carrying the
    /// status and body.
    mod contract {
        use super::*;
        use hyper::service::{make_service_fn, service_fn};
        use hyper::{Body, Request, Response, Server};
        use std::convert::Infallible;
        use std::net::SocketAddr;

        async fn spawn_test_app(status: u16, body: &'static [u8]) -> Url {
            spawn_test_app_with_header(status, body, None).await
        }

        async fn spawn_test_app_with_header(
            status: u16,
            body: &'static [u8],
            fulfillment_header: Option<&'static str>,
        ) -> Url {
            let make_svc = make_service_fn(move |_conn| async move {
                Ok::<_, Infallible>(service_fn(move |_req: Request<Body>| async move {
                    let mut response = Response::builder().status(status);
                    if let Some(header_value) = fulfillment_header {
                        response = response.header(FULFILLMENT_HEADER, header_value);
                    }
                    Ok::<_, Infallible>(response.body(Body::from(body)).unwrap())
                }))
            });

            let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
            let server = Server::bind(&addr).serve(make_svc);
            let bound_addr = server.local_addr();
            tokio::spawn(server);

            Url::parse(&format!("http://{bound_addr}")).unwrap()
        }

        async fn assert_upholds_the_contract(client: &dyn AppClient) {
            let accepting = spawn_test_app(200, b"accepted").await;
            let declining = spawn_test_app(400, b"declined").await;
            let received_at = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();

            let accepted = client
                .deliver(
                    &accepting,
                    &prepare("g.example.app", b"payload"),
                    received_at,
                )
                .await;
            assert_eq!(
                accepted,
                AppOutcome::Delivered {
                    data: b"accepted".to_vec(),
                    fulfillment: None,
                }
            );

            let declined = client
                .deliver(
                    &declining,
                    &prepare("g.example.app", b"payload"),
                    received_at,
                )
                .await;
            assert_eq!(
                declined,
                AppOutcome::Declined {
                    status: 400,
                    body: b"declined".to_vec(),
                }
            );
        }

        #[tokio::test]
        async fn http_app_client_upholds_the_contract() {
            assert_upholds_the_contract(&HttpAppClient::new()).await;
        }

        #[tokio::test]
        async fn fake_app_client_upholds_the_contract() {
            let fake = FakeAppClient::new();
            let accepting = Url::parse("http://fake-accepting").unwrap();
            let declining = Url::parse("http://fake-declining").unwrap();
            fake.respond(
                &accepting,
                AppOutcome::Delivered {
                    data: b"accepted".to_vec(),
                    fulfillment: None,
                },
            );
            fake.respond(
                &declining,
                AppOutcome::Declined {
                    status: 400,
                    body: b"declined".to_vec(),
                },
            );

            let received_at = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
            let accepted = fake
                .deliver(
                    &accepting,
                    &prepare("g.example.app", b"payload"),
                    received_at,
                )
                .await;
            assert_eq!(
                accepted,
                AppOutcome::Delivered {
                    data: b"accepted".to_vec(),
                    fulfillment: None,
                }
            );
            let declined = fake
                .deliver(
                    &declining,
                    &prepare("g.example.app", b"payload"),
                    received_at,
                )
                .await;
            assert_eq!(
                declined,
                AppOutcome::Declined {
                    status: 400,
                    body: b"declined".to_vec(),
                }
            );
        }

        #[tokio::test]
        async fn http_app_client_reports_a_connection_failure_as_unreachable() {
            // Port 0 never accepts a connection, so this fails fast without a timeout.
            let unroutable = Url::parse("http://127.0.0.1:0").unwrap();
            let received_at = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();

            let outcome = HttpAppClient::new()
                .deliver(
                    &unroutable,
                    &prepare("g.example.app", b"payload"),
                    received_at,
                )
                .await;

            assert!(matches!(outcome, AppOutcome::Unreachable { .. }));
        }

        /// The app's participation in fulfilling a packet (issue #417): a
        /// `TOON-Fulfillment` response header round-trips into
        /// `AppOutcome::Delivered::fulfillment` so `Connector` can verify it
        /// against the packet's execution condition.
        #[tokio::test]
        async fn http_app_client_parses_a_well_formed_fulfillment_header() {
            let accepting = spawn_test_app_with_header(
                200,
                b"accepted",
                Some("0707070707070707070707070707070707070707070707070707070707070707"),
            )
            .await;
            let received_at = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();

            let outcome = HttpAppClient::new()
                .deliver(
                    &accepting,
                    &prepare("g.example.app", b"payload"),
                    received_at,
                )
                .await;

            assert_eq!(
                outcome,
                AppOutcome::Delivered {
                    data: b"accepted".to_vec(),
                    fulfillment: Some([7u8; 32]),
                }
            );
        }

        #[tokio::test]
        async fn http_app_client_treats_a_malformed_fulfillment_header_as_absent() {
            let accepting =
                spawn_test_app_with_header(200, b"accepted", Some("not-hex-and-wrong-length"))
                    .await;
            let received_at = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();

            let outcome = HttpAppClient::new()
                .deliver(
                    &accepting,
                    &prepare("g.example.app", b"payload"),
                    received_at,
                )
                .await;

            assert_eq!(
                outcome,
                AppOutcome::Delivered {
                    data: b"accepted".to_vec(),
                    fulfillment: None,
                }
            );
        }
    }
}
