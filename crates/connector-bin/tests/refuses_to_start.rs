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
