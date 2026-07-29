//! Shared process-spawning support for `connector-bin`'s black-box tests.
//! Originally written for `two_connectors_and_a_stub_app.rs`; factored out
//! so other test binaries can drive the same real, compiled
//! `connector`/`stub-app` binaries instead of reimplementing this.
//!
//! Not every consumer uses every helper (`refuses_to_start.rs` still has
//! its own smaller variant for its narrower needs), so this module is
//! allowed dead code per test binary rather than forcing every caller to
//! use every function.

#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

use chrono::{Duration as ChronoDuration, Utc};
use connector_domain::{derive_condition, EnvelopeRequest, Prepare};
use connector_signer::giftwrap::{derive_fulfillment, seal_request};
use connector_signer::{LocalSigner, PublicKeyBytes, Signer};

/// A spawned child process, killed and reaped on drop -- so a test that
/// panics midway still leaves no orphaned process behind.
pub struct Process {
    child: Child,
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn write_config(text: &str) -> tempfile::NamedTempFile {
    let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
    write!(config_file, "{text}").expect("write config file");
    config_file
}

pub fn write_raw_key_file(seed: u8) -> tempfile::NamedTempFile {
    let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
    key_file
        .write_all(&[seed; 32])
        .expect("write raw 32-byte key");
    key_file
}

/// The identity `write_raw_key_file(seed)` produces, reconstructed the same
/// way `connector-cli::runtime::build` derives a signer from raw key-file
/// bytes -- so a test can seal to a real connector process's actual
/// identity without needing to ask it over the wire.
pub fn identity_from_key_seed(seed: u8) -> PublicKeyBytes {
    LocalSigner::from_secret_bytes("test-identity", [seed; 32])
        .expect("valid key seed")
        .public_key()
        .expect("public key")
}

/// ADR 0018/issue #524: a terminated route's `Prepare.data` is a gift wrap
/// sealed to the terminating connector's identity -- `receiver_public`,
/// derived the same way `runtime::build()` derives it in the real binary
/// (from the `[signer] key_file` raw bytes) -- around a minimal `POST /`
/// envelope carrying `body`. Returns the wire bytes for `Prepare.data` and
/// the shared secret the wrap carries, to open the sealed `Fulfill`/`Reject`
/// this produces or to compute the fulfilment ADR 0019/issue #525 derives
/// from it.
pub fn sealed_prepare_data(body: &[u8], receiver_public: &PublicKeyBytes) -> (Vec<u8>, [u8; 32]) {
    let plaintext = EnvelopeRequest {
        method: "POST".to_string(),
        target: "/".to_string(),
        headers: vec![],
        body: body.to_vec(),
    }
    .encode();
    seal_request(&plaintext, receiver_public).expect("seal")
}

/// A `Prepare` whose `execution_condition` matches the fulfilment
/// `shared_secret` derives (ADR 0019, issue #525) -- what a genuine sender
/// mints its condition from before ever transmitting a packet sealed with
/// that same secret.
pub fn sample_prepare(destination: &str, data: Vec<u8>, shared_secret: &[u8; 32]) -> Prepare {
    Prepare {
        amount: 0,
        expires_at: Utc::now() + ChronoDuration::minutes(5),
        execution_condition: derive_condition(&derive_fulfillment(shared_secret)),
        destination: destination.to_string(),
        data,
    }
}

/// Parse the `addr` field out of one of the connector binary's structured
/// JSON tracing log lines.
pub fn parse_json_log_addr(line: &str) -> String {
    let parsed: serde_json::Value = serde_json::from_str(line).expect("JSON log line");
    parsed["fields"]["addr"]
        .as_str()
        .expect("addr field")
        .to_string()
}

pub struct StubApp {
    _process: Process,
    pub addr: String,
}

pub fn spawn_stub_app() -> StubApp {
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

pub struct ConnectorProcess {
    _process: Process,
    pub client_edge_addr: String,
    pub peer_wire_addr: Option<String>,
}

pub fn spawn_connector(config_path: &std::path::Path) -> ConnectorProcess {
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
