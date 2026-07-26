//! Black-box coverage of ADR 0009's "refuse to start" contract, run against
//! the actual compiled binary rather than a library call: a valid config
//! lets the process exit cleanly, an invalid one produces a specific error
//! on stderr and a non-zero exit, and neither leaves anything half-started
//! because nothing else exists to start yet.

use std::io::Write;
use std::process::Command;

fn run(config_path: Option<&std::path::Path>) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_connector"));
    if let Some(path) = config_path {
        command.arg(path);
    }
    command.output().expect("run connector binary")
}

#[test]
fn exits_zero_with_a_valid_config() {
    let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
    key_file
        .write_all(b"not real key material, just needs to exist")
        .expect("write key file");

    let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
    write!(
        config_file,
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[[routes]]
prefix = "g.example.app"
handler_url = "http://localhost:4000"
"#,
        key_file.path().display()
    )
    .expect("write config file");

    let output = run(Some(config_file.path()));

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn exits_non_zero_with_an_actionable_error_on_invalid_toml() {
    let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
    write!(config_file, "this is not valid toml {{").expect("write config file");

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
    let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
    write!(
        config_file,
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "/nonexistent/does-not-exist.key"
"#
    )
    .expect("write config file");

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
