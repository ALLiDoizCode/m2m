//! Black-box coverage of the actual compiled binary, rather than a library
//! call: an invalid config produces a specific error on stderr and a
//! non-zero exit before anything is bound, and a valid config brings up a
//! real, servable node (ADR 0001: "loads configuration, constructs the
//! runtime, merges routers and serves").

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

fn run(config_path: Option<&std::path::Path>) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_connector"));
    if let Some(path) = config_path {
        command.arg(path);
    }
    command.output().expect("run connector binary")
}

fn spawn(config_path: &std::path::Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_connector"))
        .arg(config_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn connector binary")
}

/// Read stdout lines until the "connector listening" structured log line
/// appears, and return the address it reports. `client_edge_addr =
/// "127.0.0.1:0"` (used throughout this file) lets the OS pick a free
/// port, so this is the only way a test learns which one.
fn wait_for_listen_addr(child: &mut Child) -> String {
    let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
    let mut line = String::new();
    loop {
        line.clear();
        let read = stdout.read_line(&mut line).expect("read stdout");
        assert!(read > 0, "process exited before logging a listen address");
        if line.contains("connector listening") {
            let parsed: serde_json::Value =
                serde_json::from_str(&line).expect("listen line is a JSON log record");
            return parsed["fields"]["addr"]
                .as_str()
                .expect("addr field")
                .to_string();
        }
    }
}

fn write_config(text: &str) -> tempfile::NamedTempFile {
    let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
    write!(config_file, "{text}").expect("write config file");
    config_file
}

fn write_raw_key_file() -> tempfile::NamedTempFile {
    let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
    key_file
        .write_all(&[7u8; 32])
        .expect("write raw 32-byte key");
    key_file
}

#[tokio::test]
async fn serves_traffic_with_a_valid_config() {
    let key_file = write_raw_key_file();
    let config_file = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[[routes]]
prefix = "g.example.app"
handler_url = "http://localhost:4000"
price = 0
"#,
        key_file.path().display()
    ));

    let mut child = spawn(config_file.path());
    let addr = wait_for_listen_addr(&mut child);

    // GET isn't mounted (client-edge-spec.md only defines POST /ilp) --
    // a 405 still proves a live axum router answered the request, which
    // is all this test needs: the binary actually serves rather than
    // exiting once its configuration is loaded.
    let response = reqwest::get(format!("http://{addr}/ilp"))
        .await
        .expect("request the running connector");
    assert_eq!(response.status(), reqwest::StatusCode::METHOD_NOT_ALLOWED);

    child.kill().expect("kill connector");
    child.wait().expect("wait for connector to exit");
}

#[tokio::test]
async fn serves_the_operator_surface_when_configured() {
    let key_file = write_raw_key_file();
    let config_file = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[operator]
bearer_token = "operator-secret"
write_keys = ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]
"#,
        key_file.path().display()
    ));

    let mut child = spawn(config_file.path());
    let addr = wait_for_listen_addr(&mut child);

    let client = reqwest::Client::new();
    let unauthenticated = client
        .get(format!("http://{addr}/metrics"))
        .send()
        .await
        .expect("request /metrics with no token");
    assert_eq!(unauthenticated.status(), reqwest::StatusCode::UNAUTHORIZED);

    let authenticated = client
        .get(format!("http://{addr}/metrics"))
        .bearer_auth("operator-secret")
        .send()
        .await
        .expect("request /metrics with the configured token");
    assert_eq!(authenticated.status(), reqwest::StatusCode::OK);
    let body = authenticated.text().await.expect("metrics body");
    assert!(body.contains("toon_fees_earned_total"));

    child.kill().expect("kill connector");
    child.wait().expect("wait for connector to exit");
}

#[test]
fn exits_non_zero_with_an_actionable_error_on_invalid_toml() {
    let config_file = write_config("this is not valid toml {");

    let output = run(Some(config_file.path()));

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.to_lowercase().contains("toml"),
        "expected a TOML-specific error, got: {stderr}"
    );
}

#[test]
fn exits_non_zero_with_a_missing_signer_key_file() {
    let config_file = write_config(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "/nonexistent/does-not-exist.key"
"#,
    );

    let output = run(Some(config_file.path()));

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("does-not-exist.key"),
        "expected the offending path in the error, got: {stderr}"
    );
}

#[test]
fn exits_non_zero_when_no_config_path_is_given() {
    let output = run(None);

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("usage"));
}

#[test]
fn exits_non_zero_when_the_operator_surface_is_enabled_with_no_write_keys() {
    let key_file = write_raw_key_file();
    let config_file = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[operator]
bearer_token = "operator-secret"
"#,
        key_file.path().display()
    ));

    let output = run(Some(config_file.path()));

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("write_keys"),
        "expected an actionable write_keys error, got: {stderr}"
    );
}

#[test]
fn exits_non_zero_when_the_operator_surface_is_enabled_with_no_bearer_token() {
    let key_file = write_raw_key_file();
    let config_file = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[operator]
write_keys = ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]
"#,
        key_file.path().display()
    ));

    let output = run(Some(config_file.path()));

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("bearer_token"),
        "expected an actionable bearer_token error, got: {stderr}"
    );
}

#[test]
fn exits_non_zero_when_the_signer_key_file_has_invalid_material() {
    let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
    key_file
        .write_all(b"not real key material, just needs to exist")
        .expect("write key file");
    let config_file = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"
"#,
        key_file.path().display()
    ));

    let output = run(Some(config_file.path()));

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("key_file"),
        "expected an actionable signer key error, got: {stderr}"
    );
}

#[test]
fn exits_non_zero_when_the_signer_location_is_kms() {
    let config_file = write_config(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
kms_key_id = "arn:aws:kms:us-east-1:123:key/abc"
"#,
    );

    let output = run(Some(config_file.path()));

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("key management service"),
        "expected an actionable unsupported-signer-location error, got: {stderr}"
    );
}

#[test]
fn exits_non_zero_when_a_terminated_route_has_no_price() {
    let key_file = write_raw_key_file();
    let config_file = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[[routes]]
prefix = "g.example.app"
handler_url = "http://localhost:4000"
"#,
        key_file.path().display()
    ));

    let output = run(Some(config_file.path()));

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("price"),
        "expected an actionable missing-price error, got: {stderr}"
    );
}

/// Issue #556, the parse layer: a key misspelled *inside* a section used
/// to be dropped by `toml::from_str` and the node started as if it had
/// never been written. `[operator]` is the sharpest case -- a mistyped
/// `bearer_tokn` left the section resolving as "present but
/// unauthenticated", so ADR 0008's own refuse-to-start error fired and
/// pointed the operator at the wrong thing.
#[test]
fn exits_non_zero_on_a_misspelled_key_inside_a_section() {
    let key_file = write_raw_key_file();
    let config_file = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[operator]
bearer_tokn = "operator-secret"
write_keys = ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]
"#,
        key_file.path().display()
    ));

    let output = run(Some(config_file.path()));

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("bearer_tokn"),
        "expected the error to name the misspelled key, got: {stderr}"
    );
}

/// Issue #556: `fee` on a terminated route was read by no branch of
/// `resolve_routes` and silently earned nothing -- the same shape #520
/// refused for a missing `price`.
#[test]
fn exits_non_zero_when_a_terminated_route_sets_a_fee() {
    let key_file = write_raw_key_file();
    let config_file = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[[routes]]
prefix = "g.example.app"
handler_url = "http://localhost:4000"
price = 100
fee = 5
"#,
        key_file.path().display()
    ));

    let output = run(Some(config_file.path()));

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("fee"),
        "expected an actionable fee-on-a-terminated-route error, got: {stderr}"
    );
}

/// The mirror image: `price` on a route forwarding to a peer charged
/// nothing, so a node written to earn 100 per forwarded packet carried
/// them free.
#[test]
fn exits_non_zero_when_a_peer_route_sets_a_price() {
    let key_file = write_raw_key_file();
    let config_file = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[[routes]]
prefix = "g.example.store"
peer_id = "store"
price = 100
"#,
        key_file.path().display()
    ));

    let output = run(Some(config_file.path()));

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("price"),
        "expected an actionable price-on-a-peer-route error, got: {stderr}"
    );
}

// -- Durable claim state (issue #605) --

/// A node that can accept claims but names nowhere durable to record them
/// never starts. Without this it starts happily, serves, and gives every
/// already-spent claim back to the client the next time it restarts --
/// with nothing in any log to see, because from the gate's point of view
/// every replayed nonce genuinely looks fresh.
#[test]
fn exits_non_zero_when_client_channels_are_configured_without_a_state_dir() {
    let key_file = write_raw_key_file();
    let config_file = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{key_file}"

[[client_channels]]
channel_id = "0x{channel}"
counterparty = "0x00000000000000000000000000000000000000aa"
chain_id = 8453
token_network_address = "0x00000000000000000000000000000000000000bb"
"#,
        key_file = key_file.path().display(),
        channel = "ab".repeat(32),
    ));

    let output = run(Some(config_file.path()));

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("state_dir"),
        "expected the error to name the field to add, got: {stderr}"
    );
}

/// A node with nowhere writable fails at startup, naming the path -- not
/// at the first claim, hours later, on a packet path where the only
/// honest answer left is to refuse a claim that was perfectly good.
#[test]
fn exits_non_zero_when_the_state_dir_cannot_be_written() {
    let key_file = write_raw_key_file();
    // A regular file standing where a directory is asked for: the same
    // failure a read-only mount produces, reproducible without root.
    let blocker = tempfile::NamedTempFile::new().expect("temp file");
    let state_dir = blocker.path().join("state");
    let config_file = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"
state_dir = "{state_dir}"

[signer]
key_file = "{key_file}"
"#,
        key_file = key_file.path().display(),
        state_dir = state_dir.display(),
    ));

    let output = run(Some(config_file.path()));

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("state_dir") && stderr.contains(&state_dir.display().to_string()),
        "expected the error to name the unusable path, got: {stderr}"
    );
}

/// A journal this build cannot decode stops the node. Refusing to start is
/// the whole point: the only other option is starting from no watermarks,
/// which is exactly the defect.
#[test]
fn exits_non_zero_on_a_corrupt_claim_journal() {
    let key_file = write_raw_key_file();
    let state_dir = tempfile::tempdir().expect("temp state dir");
    std::fs::write(
        state_dir.path().join("client-edge-claims.log"),
        "not a journal entry\n",
    )
    .expect("write a corrupt journal");
    let config_file = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"
state_dir = "{state_dir}"

[signer]
key_file = "{key_file}"
"#,
        key_file = key_file.path().display(),
        state_dir = state_dir.path().display(),
    ));

    let output = run(Some(config_file.path()));

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("client-edge-claims.log"),
        "expected the error to name the journal it could not replay, got: {stderr}"
    );
}

// -- The deleted raw-TCP peer wire (ADR 0027, issue #679) and the peer
// config surface that replaced it (issue #677, peer-carriage-spec.md
// §11) --

/// ADR 0009's "refuse to start" contract against the peer config surface:
/// a route naming a `peer_id` no `[[peers]]` entry configures is exactly
/// the kind of misconfigured node that must never come up quietly
/// connected to nothing. (Moved here from
/// `two_connectors_and_a_stub_app.rs`, which was deleted with the raw-TCP
/// wire it proved.)
#[test]
fn exits_non_zero_when_a_peer_route_names_an_unconfigured_peer_id() {
    let key_file = write_raw_key_file();
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

    let output = run(Some(config_file.path()));

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("peer-b"),
        "expected an actionable unknown-peer-id error, got: {stderr}"
    );
}

/// The devnet boxes run bind-mounted configs that lead the repo copies, so
/// a stale one naming the removed `peer_wire_addr` has to stop the binary
/// and say where to read about it -- not be ignored into a node that looks
/// healthy and never peers.
#[test]
fn exits_non_zero_when_a_stale_config_sets_peer_wire_addr() {
    let key_file = write_raw_key_file();
    let config_file = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"
peer_wire_addr = "0.0.0.0:4001"

[signer]
key_file = "{}"
"#,
        key_file.path().display()
    ));

    let output = run(Some(config_file.path()));

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("peer_wire_addr")
            && stderr.contains("docs/operators/btp-peer-transport-bringup.md"),
        "expected a named removal error pointing at the bring-up doc, got: {stderr}"
    );
}

/// The `[[peers]]` half: a `SocketAddr`-shaped `addr` is the other thing a
/// stale config carries, and it fails the same way.
#[test]
fn exits_non_zero_when_a_stale_peer_entry_sets_addr() {
    let key_file = write_raw_key_file();
    let config_file = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[[peers]]
id = "store"
addr = "127.0.0.1:4001"
"#,
        key_file.path().display()
    ));

    let output = run(Some(config_file.path()));

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("store") && stderr.contains("docs/operators/btp-peer-transport-bringup.md"),
        "expected a named removal error pointing at the bring-up doc, got: {stderr}"
    );
}

/// A peering that names no credential can never take the peer role, so it
/// would come up looking configured and admit its counterparty as an
/// ordinary client. The whole point of issue #677's load-time checks is
/// that this is loud.
#[test]
fn exits_non_zero_when_a_peer_configures_no_credential() {
    let key_file = write_raw_key_file();
    let config_file = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"
peer_expose = "btp"

[signer]
key_file = "{}"

[[peers]]
id = "store"
endpoint = "wss://store.example/btp"
"#,
        key_file.path().display()
    ));

    let output = run(Some(config_file.path()));

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("credential")
            && stderr.contains("docs/operators/btp-peer-transport-bringup.md"),
        "expected a named missing-credential error pointing at the bring-up doc, got: {stderr}"
    );
}
