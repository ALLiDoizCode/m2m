//! Issue #1220, limb 3: `docs/operators/sign-write.sh` is a real signer, not
//! prose. This boots a config-driven node with a real `[operator]`
//! allowlist and proves the script's output authenticates a write against
//! this node's own verifier -- the same one `connector send` and every
//! other write go through (`connector-operator`'s RFC 9421 check).
//!
//! `POST /peers` is the doc's own worked example, and it needs no chain to
//! prove this: `establish_peering` checks the write's signature FIRST, and
//! only then fetches the counterparty's self-description
//! (`crates/connector-operator/src/lib.rs`'s `upsert_peer` calls
//! `require_write_auth` before touching the body). Pointed at an address
//! nothing answers, the write authenticates, reaches `establish_peering`,
//! and fails there instead -- answering `502` (README's own "a `502` is
//! about them, a `400` is about you"). A `401`/`403` would mean the
//! script's signature never verified at all; `502` proves it did.

use std::io::Write;
use std::process::Command;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

fn script_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/operators/sign-write.sh")
}

struct Signed {
    signature_input: String,
    signature: String,
    content_digest: String,
}

/// Shell out to the shipped script exactly the way an operator would, and
/// parse its three printed headers.
fn sign(key_path: &std::path::Path, method: &str, path: &str, body: &str) -> Signed {
    let output = Command::new("bash")
        .arg(script_path())
        .args([
            "-k",
            key_path.to_str().expect("utf8 path"),
            "-X",
            method,
            "-p",
            path,
            "-b",
            body,
        ])
        .output()
        .expect("run docs/operators/sign-write.sh");
    assert!(
        output.status.success(),
        "sign-write.sh failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).expect("utf8 output");

    let mut signature_input = None;
    let mut signature = None;
    let mut content_digest = None;
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("Signature-Input: ") {
            signature_input = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("Signature: ") {
            signature = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("Content-Digest: ") {
            content_digest = Some(value.to_string());
        }
    }
    Signed {
        signature_input: signature_input.expect("script prints a Signature-Input line"),
        signature: signature.expect("script prints a Signature line"),
        content_digest: content_digest.expect("script prints a Content-Digest line"),
    }
}

/// Read `keyid="..."` back out of the printed `Signature-Input`, the same
/// value the script derived from the key file -- so the config's
/// `write_keys` and the request's `keyid` are provably the same key without
/// this test deriving it a second, independent way.
fn keyid_from(signature_input: &str) -> String {
    let marker = "keyid=\"";
    let start = signature_input
        .find(marker)
        .expect("Signature-Input names a keyid")
        + marker.len();
    let rest = &signature_input[start..];
    let end = rest.find('"').expect("keyid is quoted");
    rest[..end].to_string()
}

fn openssl_rand_32() -> [u8; 32] {
    let output = Command::new("openssl")
        .args(["rand", "32"])
        .output()
        .expect("openssl rand -- required by the script itself, so also required here");
    assert!(output.status.success());
    output
        .stdout
        .try_into()
        .expect("openssl rand 32 is 32 bytes")
}

#[tokio::test]
async fn the_shipped_script_signs_a_write_the_nodes_own_verifier_accepts() {
    let mut signer_key_file = tempfile::NamedTempFile::new().expect("temp signer key file");
    signer_key_file
        .write_all(&[7u8; 32])
        .expect("write signer key");

    // The operator write key: 32 raw bytes, the same shape
    // `connector send --operator-key` reads and the script itself accepts.
    let mut op_key_file = tempfile::NamedTempFile::new().expect("temp operator key file");
    op_key_file
        .write_all(&openssl_rand_32())
        .expect("write operator key");

    // Points at a port nothing on this host answers: `establish_peering`
    // authenticates the write first and only then dials this, so the
    // outcome below is entirely about the signature, not about anvil or a
    // settlement backend -- neither is configured on this node at all.
    let body =
        r#"{"id":"stranger","url":"https://127.0.0.1:9/ilp","fee":0,"max_packet_amount":1000}"#;
    let signed = sign(op_key_file.path(), "POST", "/peers", body);
    let keyid = keyid_from(&signed.signature_input);

    let state_dir = tempfile::tempdir().expect("temp state dir");
    let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
    write!(
        config_file,
        r#"
client_edge_addr = "127.0.0.1:0"
state_dir = "{state_dir}"

[signer]
key_file = "{signer_key}"

[operator]
bearer_token = "operator-secret"
write_keys = ["{keyid}"]
"#,
        state_dir = state_dir.path().display(),
        signer_key = signer_key_file.path().display(),
    )
    .expect("write config file");

    let command = connector_cli::run(&[
        "connector".to_string(),
        config_file.path().display().to_string(),
    ])
    .await
    .expect("run: a config-driven node with an operator surface and no settlement backend");
    let connector_cli::Command::Serve(node) = command else {
        panic!("a config path must produce a servable node");
    };

    let request = Request::builder()
        .method("POST")
        .uri("/peers")
        .header("signature-input", signed.signature_input)
        .header("signature", signed.signature)
        .header("content-digest", signed.content_digest)
        .body(Body::from(body))
        .unwrap();
    let response = node.router.oneshot(request).await.unwrap();

    assert_eq!(
        response.status(),
        StatusCode::BAD_GATEWAY,
        "502 means the write authenticated under RFC 9421 and reached \
         establish_peering, which then failed to dial an address nothing \
         answers -- a 401/403 here would mean the script's own signature \
         never verified against this node's allowlist at all"
    );
}
