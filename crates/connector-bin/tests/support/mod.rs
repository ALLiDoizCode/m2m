//! Shared process-spawning support for `connector-bin`'s black-box tests
//! (issue #488's own note on #491: "build on #495 rather than beside it").
//! Originally written for `two_connectors_and_a_stub_app.rs`; factored out
//! here so `fleet_compare_two_local_fleets.rs` drives the same real,
//! compiled `connector`/`stub-app` binaries instead of reimplementing this.
//!
//! Not every consumer uses every helper (`refuses_to_start.rs` still has
//! its own smaller variant for its narrower needs), so this module is
//! allowed dead code per test binary rather than forcing every caller to
//! use every function.

#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

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
