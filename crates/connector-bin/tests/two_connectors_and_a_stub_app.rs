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

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

use chrono::{Duration as ChronoDuration, Utc};
use connector_domain::{derive_condition, Fulfill, Prepare, Reject};

const FULFILLMENT: [u8; 32] = [7u8; 32];

/// Must match `stub_app.rs`'s own `DECLINE_BODY` -- the two are separate
/// binaries, so there is no shared constant to import.
const DECLINE_BODY: &[u8] = b"please decline this one";

/// A spawned child process, killed and reaped on drop -- so a test that
/// panics midway still leaves no orphaned process behind.
struct Process {
    child: Child,
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn write_config(text: &str) -> tempfile::NamedTempFile {
    let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
    write!(config_file, "{text}").expect("write config file");
    config_file
}

fn write_raw_key_file(seed: u8) -> tempfile::NamedTempFile {
    let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
    key_file
        .write_all(&[seed; 32])
        .expect("write raw 32-byte key");
    key_file
}

/// Parse the `addr` field out of one of the connector binary's structured
/// JSON tracing log lines (mirrors `refuses_to_start.rs`'s own helper).
fn parse_json_log_addr(line: &str) -> String {
    let parsed: serde_json::Value = serde_json::from_str(line).expect("JSON log line");
    parsed["fields"]["addr"]
        .as_str()
        .expect("addr field")
        .to_string()
}

struct StubApp {
    _process: Process,
    addr: String,
}

fn spawn_stub_app() -> StubApp {
    let mut child = Command::new(env!("CARGO_BIN_EXE_stub-app"))
        .arg("127.0.0.1:0")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn stub-app");
    let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
    let process = Process { child };

    let mut line = String::new();
    let addr = loop {
        line.clear();
        let read = stdout.read_line(&mut line).expect("read stdout");
        assert!(read > 0, "stub-app exited before printing its address");
        if let Some(addr) = line.trim().strip_prefix("stub-app listening ") {
            break addr.to_string();
        }
    };

    StubApp {
        addr,
        _process: process,
    }
}

struct ConnectorProcess {
    _process: Process,
    client_edge_addr: String,
    peer_wire_addr: Option<String>,
}

fn spawn_connector(config_path: &std::path::Path) -> ConnectorProcess {
    let mut child = Command::new(env!("CARGO_BIN_EXE_connector"))
        .arg(config_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn connector");
    let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
    let process = Process { child };

    // A node with no `peer_wire_addr` never logs "peer wire listening", so
    // this can't wait for both lines in a fixed order -- read until
    // "connector listening" is seen, remembering "peer wire listening"
    // along the way if it comes first.
    let mut peer_wire_addr = None;
    let mut line = String::new();
    let client_edge_addr = loop {
        line.clear();
        let read = stdout.read_line(&mut line).expect("read stdout");
        assert!(read > 0, "connector exited before logging a listen address");
        if line.contains("peer wire listening") {
            peer_wire_addr = Some(parse_json_log_addr(&line));
        } else if line.contains("connector listening") {
            break parse_json_log_addr(&line);
        }
    };

    ConnectorProcess {
        _process: process,
        client_edge_addr,
        peer_wire_addr,
    }
}

fn sample_prepare(destination: &str, data: &[u8]) -> Prepare {
    Prepare {
        amount: 0,
        expires_at: Utc::now() + ChronoDuration::minutes(5),
        execution_condition: derive_condition(&FULFILLMENT),
        destination: destination.to_string(),
        data: data.to_vec(),
    }
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

    // A packet destined for "g.b.app": connector A has no static route for
    // it, only the peer route for the "g.b" prefix -- so a fulfilled
    // response proves the hop to connector B happened over the real TCP
    // peer wire this test wired up, not in-process.
    let prepare = sample_prepare("g.b.app", b"hello from the client edge");
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
    assert_eq!(
        fulfill.data,
        b"delivered by stub app: hello from the client edge"
    );

    // The stub app can also decline -- proving a real failure travels back
    // through both hops too, not just the happy path (the stub app "returns
    // success or failure", per the issue's own acceptance criteria).
    let declining_prepare = sample_prepare("g.b.app", DECLINE_BODY);
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
        reject.message.contains("402"),
        "expected the app's 402 decline to travel back, got: {}",
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
