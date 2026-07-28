//! End-to-end proof (issue #488, parent #431/ADR 0013) that the *deployed*
//! shape works: two real connector processes, started from real
//! `connector.toml` files -- the same shape a deployment would use, not a
//! struct built in Rust -- peer with each other over a real TCP
//! connection, and a packet sent to one's client edge is delivered over
//! HTTP to a stub app behind the other, itself a genuinely
//! payment-oblivious process.
//!
//! Spawns processes, not containers (the agent sandbox has no Docker): the
//! same `Child`-and-`Drop` pattern
//! `crates/connector-settlement-evm/tests/support/mod.rs` already uses for
//! `anvil`. Every process binds `127.0.0.1:0` and reports back whatever
//! port the OS actually gave it, so nothing here leaks a fixed port or
//! collides between runs.

use std::process::Command;

use chrono::{Duration as ChronoDuration, Utc};
use connector_domain::{
    derive_condition, EnvelopeRequest, EnvelopeResponse, Fulfill, Prepare, Reject,
};
use connector_signer::giftwrap::{open_response, seal_request};
use connector_signer::{LocalSigner, PublicKeyBytes, Signer};

mod support;
use support::{spawn_connector, spawn_stub_app, write_config, write_raw_key_file};

const FULFILLMENT: [u8; 32] = [7u8; 32];

/// Must match `stub_app.rs`'s own `DECLINE_BODY` -- the two are separate
/// binaries, so there is no shared constant to import.
const DECLINE_BODY: &[u8] = b"please decline this one";

/// ADR 0018/issue #524: a terminated route's `Prepare.data` is a gift wrap
/// sealed to the terminating connector's identity -- `receiver_public`,
/// derived the same way `runtime::build()` derives it in the real binary
/// (from the `[signer] key_file` raw bytes) -- around a minimal `POST /`
/// envelope carrying `body`, matching `stub_app`'s one handler, mounted at
/// `/`. Returns the wire bytes for `Prepare.data` and the shared secret the
/// wrap carries, to open the sealed `Fulfill`/`Reject` this produces.
fn sealed_prepare_data(body: &[u8], receiver_public: &PublicKeyBytes) -> (Vec<u8>, [u8; 32]) {
    let plaintext = EnvelopeRequest {
        method: "POST".to_string(),
        target: "/".to_string(),
        headers: vec![],
        body: body.to_vec(),
    }
    .encode();
    seal_request(&plaintext, receiver_public).expect("seal")
}

fn sample_prepare(destination: &str, data: Vec<u8>) -> Prepare {
    Prepare {
        amount: 0,
        expires_at: Utc::now() + ChronoDuration::minutes(5),
        execution_condition: derive_condition(&FULFILLMENT),
        destination: destination.to_string(),
        data,
    }
}

/// The identity `write_raw_key_file(seed)` produces, reconstructed the same
/// way `connector-cli::runtime::build` derives a signer from raw key-file
/// bytes -- so this test can seal to a real connector process's actual
/// identity without needing to ask it over the wire.
fn identity_from_key_seed(seed: u8) -> PublicKeyBytes {
    LocalSigner::from_secret_bytes("test-identity", [seed; 32])
        .expect("valid key seed")
        .public_key()
        .expect("public key")
}

#[tokio::test]
async fn two_real_connector_processes_peer_over_the_network_and_deliver_to_a_stub_app() {
    let stub_app = spawn_stub_app();

    // Connector B: accepts peer connections and terminates "g.b.app" at the
    // stub app -- the far side of the hop.
    let key_b = write_raw_key_file(2);
    let config_b = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"
peer_wire_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[[routes]]
prefix = "g.b.app"
handler_url = "http://{}"
price = 0
"#,
        key_b.path().display(),
        stub_app.addr,
    ));
    let connector_b = spawn_connector(config_b.path());
    let peer_wire_addr_b = connector_b
        .peer_wire_addr
        .clone()
        .expect("connector B's peer wire address");

    // Connector A: dials connector B as "peer-b" and forwards everything
    // under "g.b" to it -- the near side, reached through the client edge.
    // It never binds its own peer_wire_addr: this test only forwards one
    // direction, and an app never needs to accept peer connections.
    let key_a = write_raw_key_file(1);
    let config_a = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[[peers]]
id = "peer-b"
addr = "{}"

[[routes]]
prefix = "g.b"
peer_id = "peer-b"
fee = 0
"#,
        key_a.path().display(),
        peer_wire_addr_b,
    ));
    let connector_a = spawn_connector(config_a.path());

    let client = reqwest::Client::new();

    // Connector B's real identity -- its `[signer] key_file` was written by
    // `write_raw_key_file(2)` above -- is what a real sender would have
    // learned from `GET /ilp/identity` before ever forming this packet.
    let connector_b_identity = identity_from_key_seed(2);

    // A packet destined for "g.b.app": connector A has no static route for
    // it, only the peer route for the "g.b" prefix -- so a fulfilled
    // response proves the hop to connector B happened over the real TCP
    // peer wire this test wired up, not in-process.
    let (data, shared_secret) =
        sealed_prepare_data(b"hello from the client edge", &connector_b_identity);
    let prepare = sample_prepare("g.b.app", data);
    let response = client
        .post(format!("http://{}/ilp", connector_a.client_edge_addr))
        .body(prepare.encode())
        .send()
        .await
        .expect("POST /ilp to connector A");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body = response.bytes().await.expect("response body");
    let fulfill = Fulfill::decode(&body).expect("decode Fulfill");
    assert_eq!(fulfill.fulfillment, FULFILLMENT);
    // Real HTTP end to end, so the response envelope carries whatever
    // incidental headers axum added (`content-type`, `date`, ...) -- only
    // status and body are asserted, exactly as the shared `AppClient`
    // contract suite in `connector-runtime` does for the same reason.
    // `fulfill.data` is sealed (ADR 0018) with the request's own shared
    // secret, opened here the same way a real client would.
    let opened = open_response(&shared_secret, &fulfill.data).expect("open sealed response");
    let response_envelope = EnvelopeResponse::decode(&opened).expect("decode envelope");
    assert_eq!(response_envelope.status, 200);
    assert_eq!(
        response_envelope.body,
        b"delivered by stub app: hello from the client edge"
    );

    // The stub app can also decline -- proving a real failure travels back
    // through both hops too, not just the happy path (the stub app "returns
    // success or failure", per the issue's own acceptance criteria). Per
    // issue #521/ADR 0020, the app's 402 is itself just an answer, not a
    // transport failure -- what actually rejects this is that the stub
    // app's decline branch supplies no `TOON-Fulfillment` header (issue
    // #417, until #525 derives a fulfilment instead of asking the app for
    // one), the same rule a 200 with no header would also fail.
    let (decline_data, _shared_secret) = sealed_prepare_data(DECLINE_BODY, &connector_b_identity);
    let declining_prepare = sample_prepare("g.b.app", decline_data);
    let response = client
        .post(format!("http://{}/ilp", connector_a.client_edge_addr))
        .body(declining_prepare.encode())
        .send()
        .await
        .expect("POST /ilp to connector A (decline case)");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body = response.bytes().await.expect("response body");
    let reject = Reject::decode(&body).expect("decode Reject");
    assert!(
        reject.message.contains("execution condition"),
        "expected a reject for lack of a verifying fulfillment, got: {}",
        reject.message
    );
}

/// ADR 0009's "refuse to start" contract, exercised against this ticket's
/// own new config surface: a route naming a `peer_id` no `[[peers]]` entry
/// configures is exactly the kind of misconfigured node that must never
/// come up quietly connected to nothing.
#[test]
fn a_peer_route_naming_an_unconfigured_peer_id_refuses_to_start() {
    let key_file = write_raw_key_file(3);
    let config_file = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[[routes]]
prefix = "g.b"
peer_id = "peer-b"
"#,
        key_file.path().display()
    ));

    let output = Command::new(env!("CARGO_BIN_EXE_connector"))
        .arg(config_file.path())
        .output()
        .expect("run connector binary");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("peer-b"),
        "expected an actionable unknown-peer-id error, got: {stderr}"
    );
}
