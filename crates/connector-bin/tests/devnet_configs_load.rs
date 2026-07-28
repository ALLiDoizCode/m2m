//! Proves the devnet overlay's own committed `connector.toml` files
//! (issue #490, ADR 0013's parallel fleet) load and serve by the actual
//! compiled binary -- the first acceptance criterion -- and, per issue
//! #557, that each file's terminating route is actually priced: a
//! claimless request to it is answered with the x402 greeting (#552)
//! rather than served for nothing. Reachability of the peer or the apps
//! behind either route is explicitly NOT proven here -- that would need
//! Docker/real infrastructure this sandbox doesn't have.
//!
//! Reads the files exactly as committed and only substitutes what a real
//! deployment must also substitute: the bind addresses (fixed devnet ports
//! would flake or collide across parallel test runs -- every other test in
//! this crate binds `127.0.0.1:0` for the same reason) and the signer key
//! file (real key material is never committed -- see `.gitignore`).
//! Everything else -- prefixes, routes, peer id/addr, price -- is the
//! literal committed content.

use chrono::{Duration as ChronoDuration, Utc};
use connector_domain::{derive_condition, EnvelopeRequest, Prepare};

mod support;
use support::{spawn_connector, write_config, write_raw_key_file};

const APEX_CONFIG: &str = include_str!("../../../infra/linode-node/connector-rust.toml");
const STORE_CONFIG: &str = include_str!("../../../infra/linode-store/connector-rust.toml");

/// Substitute the one config value that cannot be committed (the signer key
/// path) and the bind addresses that must be ephemeral in a test, leaving
/// every other line -- prefixes, handler URLs, peer id/addr, price -- exactly
/// as committed.
fn with_test_addresses(raw: &str, key_path: &std::path::Path) -> String {
    raw.replace(
        "key_file = \"/app/data/signer.key\"",
        &format!("key_file = \"{}\"", key_path.display()),
    )
    .replace(
        "client_edge_addr = \"0.0.0.0:4000\"",
        "client_edge_addr = \"127.0.0.1:0\"",
    )
    .replace(
        "peer_wire_addr = \"0.0.0.0:4001\"",
        "peer_wire_addr = \"127.0.0.1:0\"",
    )
}

/// A claimless PREPARE addressed to `destination` -- no `ILP-Payment-Channel-
/// Claim`/`-Wrapped` header exists on this HTTP request, matching what any
/// real unpaying sender would send. The envelope body is irrelevant: a
/// priced route answers with terms before ever decoding it as work for the
/// app (issue #526).
fn unpaid_prepare(destination: &str) -> Prepare {
    Prepare {
        amount: 0,
        expires_at: Utc::now() + ChronoDuration::minutes(5),
        execution_condition: derive_condition(&[0u8; 32]),
        destination: destination.to_string(),
        data: EnvelopeRequest {
            method: "POST".to_string(),
            target: "/".to_string(),
            headers: vec![],
            body: vec![],
        }
        .encode(),
    }
}

/// Issue #557's core proof: a claimless request to `destination` on a node
/// started from a committed devnet config is answered with the x402
/// greeting (HTTP 402, terms naming `expected_price`) instead of being
/// forwarded to the app -- the free-gateway failure mode this issue closes.
async fn assert_answered_with_x402_greeting(
    client_edge_addr: &str,
    destination: &str,
    expected_price: u64,
) {
    let response = reqwest::Client::new()
        .post(format!("http://{client_edge_addr}/ilp"))
        .body(unpaid_prepare(destination).encode())
        .send()
        .await
        .expect("POST /ilp");
    assert_eq!(
        response.status(),
        reqwest::StatusCode::PAYMENT_REQUIRED,
        "a claimless request to a priced route must be greeted, not served"
    );
    let terms: serde_json::Value = response.json().await.expect("x402 JSON terms");
    assert_eq!(
        terms["accepts"][0]["amount"],
        expected_price.to_string(),
        "greeted price must match the route's committed `price`"
    );
}

#[tokio::test]
async fn the_apex_relay_side_devnet_config_loads_and_serves() {
    assert!(APEX_CONFIG.contains("g.rust.relay"));
    assert!(APEX_CONFIG.contains("g.rust.store"));

    let key_file = write_raw_key_file(9);
    let config_file = write_config(&with_test_addresses(APEX_CONFIG, key_file.path()));

    // No peer_wire_addr in this file (the apex only dials out) -- spawn_connector
    // only waits for "connector listening", which is all this file ever logs.
    let connector = spawn_connector(config_file.path());
    assert!(connector.peer_wire_addr.is_none());

    assert_answered_with_x402_greeting(&connector.client_edge_addr, "g.rust.relay", 1000).await;
}

#[tokio::test]
async fn the_store_side_devnet_config_loads_and_serves() {
    assert!(STORE_CONFIG.contains("g.rust.store"));

    let key_file = write_raw_key_file(9);
    let config_file = write_config(&with_test_addresses(STORE_CONFIG, key_file.path()));

    // This file configures peer_wire_addr (it accepts the apex's connection),
    // so spawn_connector's wait covers both listeners.
    let connector = spawn_connector(config_file.path());
    assert!(connector.peer_wire_addr.is_some());

    assert_answered_with_x402_greeting(&connector.client_edge_addr, "g.rust.store", 1000).await;
}
