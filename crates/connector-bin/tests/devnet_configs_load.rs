//! Proves the devnet overlay's own committed `connector.toml` files
//! (issue #490, ADR 0013's parallel fleet) load and serve by the actual
//! compiled binary -- the first acceptance criterion, and per the issue's
//! own scope boundary, the only one this sandbox (no Docker, no
//! infrastructure credentials) can verify. Reachability of the peer or the
//! apps behind either route is explicitly NOT proven here.
//!
//! Reads the files exactly as committed and only substitutes what a real
//! deployment must also substitute: the bind addresses (fixed devnet ports
//! would flake or collide across parallel test runs -- every other test in
//! this crate binds `127.0.0.1:0` for the same reason) and the signer key
//! file (real key material is never committed -- see `.gitignore`).
//! Everything else -- prefixes, routes, peer id/addr -- is the literal
//! committed content.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

const APEX_CONFIG: &str = include_str!("../../../infra/linode-node/connector-rust.toml");
const STORE_CONFIG: &str = include_str!("../../../infra/linode-store/connector-rust.toml");

fn write_raw_key_file() -> tempfile::NamedTempFile {
    let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
    key_file
        .write_all(&[9u8; 32])
        .expect("write raw 32-byte key");
    key_file
}

/// Substitute the one config value that cannot be committed (the signer key
/// path) and the bind addresses that must be ephemeral in a test, leaving
/// every other line -- prefixes, handler URLs, peer id/addr -- exactly as
/// committed.
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

fn write_config(text: &str) -> tempfile::NamedTempFile {
    let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
    write!(config_file, "{text}").expect("write config file");
    config_file
}

fn spawn(config_path: &std::path::Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_connector"))
        .arg(config_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn connector binary")
}

/// Reads stdout lines until both `"connector listening"` and (if
/// `expect_peer_wire`) `"peer wire listening"` have been seen, or the
/// process exits first -- which fails the assertion below with whatever the
/// process actually printed, rather than hanging.
fn wait_for_listen_lines(child: &mut Child, expect_peer_wire: bool) {
    let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
    let mut saw_client_edge = false;
    let mut saw_peer_wire = false;
    let mut line = String::new();
    loop {
        line.clear();
        let read = stdout.read_line(&mut line).expect("read stdout");
        assert!(read > 0, "process exited before logging a listen address");
        if line.contains("connector listening") {
            saw_client_edge = true;
        }
        if line.contains("peer wire listening") {
            saw_peer_wire = true;
        }
        if saw_client_edge && (!expect_peer_wire || saw_peer_wire) {
            return;
        }
    }
}

#[tokio::test]
async fn the_apex_relay_side_devnet_config_loads_and_serves() {
    assert!(APEX_CONFIG.contains("g.rust.relay"));
    assert!(APEX_CONFIG.contains("g.rust.store"));

    let key_file = write_raw_key_file();
    let config_file = write_config(&with_test_addresses(APEX_CONFIG, key_file.path()));

    let mut child = spawn(config_file.path());
    // No peer_wire_addr in this file (the apex only dials out) -- only the
    // client edge is expected to log a listen line.
    wait_for_listen_lines(&mut child, false);

    child.kill().expect("kill connector");
    child.wait().expect("wait for connector to exit");
}

#[tokio::test]
async fn the_store_side_devnet_config_loads_and_serves() {
    assert!(STORE_CONFIG.contains("g.rust.store"));

    let key_file = write_raw_key_file();
    let config_file = write_config(&with_test_addresses(STORE_CONFIG, key_file.path()));

    let mut child = spawn(config_file.path());
    // This file configures peer_wire_addr (it accepts the apex's
    // connection), so both listeners must come up.
    wait_for_listen_lines(&mut child, true);

    child.kill().expect("kill connector");
    child.wait().expect("wait for connector to exit");
}
