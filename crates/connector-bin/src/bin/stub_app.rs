//! A minimal, genuinely payment-oblivious HTTP app: it sees a POST request
//! and returns success or failure -- nothing about channels, claims,
//! settlement or ILP conditions enters this binary at all (issue #488).
//!
//! Built for the end-to-end test in `tests/two_connectors_and_a_stub_app.rs`,
//! but it is an ordinary standalone process like the real connector binary:
//! `stub-app [bind-addr]`, defaulting to `127.0.0.1:0` so the OS picks a free
//! port, printed to stdout once bound.

use axum::body::Bytes;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use std::io::Write;

/// Returned as the `TOON-Fulfillment` response header on every accepted
/// delivery. This app has no notion of a per-packet execution condition --
/// it is a fixed, hardcoded value, and whatever drives this app must derive
/// its own condition from this same constant
/// (`connector_domain::derive_condition`) for the delivery to be accepted
/// upstream.
const FULFILLMENT_HEX: &str = "0707070707070707070707070707070707070707070707070707070707070707";

/// A request body equal to exactly this byte string is declined with a 402
/// -- lets a driving test exercise both outcomes ("success or failure")
/// without this app knowing anything about why.
const DECLINE_BODY: &[u8] = b"please decline this one";

async fn handle(body: Bytes) -> Response {
    if body.as_ref() == DECLINE_BODY {
        return (StatusCode::PAYMENT_REQUIRED, "declined by stub app").into_response();
    }
    let mut reply = b"delivered by stub app: ".to_vec();
    reply.extend_from_slice(&body);
    (
        StatusCode::OK,
        [("TOON-Fulfillment", FULFILLMENT_HEX)],
        reply,
    )
        .into_response()
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let addr: std::net::SocketAddr = args
        .get(1)
        .map(String::as_str)
        .unwrap_or("127.0.0.1:0")
        .parse()
        .expect("valid bind address");

    let app = Router::new().route("/", post(handle));
    let server = axum::Server::bind(&addr).serve(app.into_make_service());
    println!("stub-app listening {}", server.local_addr());
    std::io::stdout().flush().expect("flush stdout");
    server.await.expect("stub-app server");
}
