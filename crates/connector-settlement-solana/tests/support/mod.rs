//! Shared support for connector-settlement-solana's integration tests:
//! whether `solana-test-validator` is on `PATH`, and the CI-vs-local policy
//! for what to do when it is not -- the Solana equivalent of
//! `connector-settlement-evm/tests/support/mod.rs` (issue #471, ADR 0007),
//! required by issue #428 itself since #471's guard has no Solana
//! tooling to gate on yet.

// Each integration-test binary compiles this module separately and uses a
// different subset of it, same as the EVM harness -- see that crate's
// support module for why `#![allow(dead_code)]` is required rather than
// optional here.
#![allow(dead_code)]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use solana_client::nonblocking::rpc_client::RpcClient;

/// True if `solana-test-validator --version` runs successfully.
pub fn solana_test_validator_available() -> bool {
    Command::new("solana-test-validator")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// The Solana twin of `connector-settlement-evm`'s `require_anvil`: a real
/// chain is genuinely under test here (ADR 0007), so a CI run lacking
/// `solana-test-validator` must fail loudly rather than silently skip and
/// report `passed` -- see issue #471, which this ticket (#428) extends to
/// Solana tooling. `CI` is set by GitHub Actions for every job, so gating on
/// it means a fresh CI job fails by default rather than depending on a
/// bespoke variable nobody remembers to set. A local run without the Solana
/// CLI installed still skips, since requiring every contributor to install
/// it just to run `cargo test` is a real cost this crate doesn't need to
/// impose.
///
/// Returns `true` when the caller should proceed with its real assertions,
/// `false` when the caller should return early (having already skipped
/// gracefully via a printed message).
pub fn require_solana_test_validator() -> bool {
    if solana_test_validator_available() {
        return true;
    }

    if std::env::var_os("CI").is_some() {
        panic!(
            "solana-test-validator is not on PATH, but CI is set -- the Rust Workspace Gate \
             must install the Solana CLI tools before this crate's tests run. Refusing to \
             silently skip and report success here; see issue #428."
        );
    }

    eprintln!(
        "skipping: solana-test-validator is not on PATH (install the Solana CLI: \
         https://docs.anza.xyz/cli/install) -- this test needs a real chain and only skips \
         because this is not a CI run"
    );
    false
}

static NEXT_PORT_OFFSET: AtomicU16 = AtomicU16::new(0);

/// A freshly spawned `solana-test-validator` instance, with
/// `connector-settlement-solana-program`'s checked-in `.so` loaded into its
/// genesis, killed (and its disposable ledger directory removed) when
/// dropped. Each instance gets its own ledger directory and ports so tests
/// spawning one concurrently don't collide.
pub struct SolanaValidator {
    child: Child,
    ledger: tempfile::TempDir,
    pub rpc_url: String,
}

impl SolanaValidator {
    pub async fn spawn() -> Self {
        let offset = NEXT_PORT_OFFSET.fetch_add(1, Ordering::SeqCst);
        let rpc_port = 18_900u16
            .wrapping_add((std::process::id() as u16) % 500)
            .wrapping_add(offset.wrapping_mul(50));
        let rpc_url = format!("http://127.0.0.1:{rpc_port}");
        let ledger = tempfile::tempdir().expect("create disposable ledger dir");

        let so_path: PathBuf = connector_settlement_solana_program::so_path();
        assert!(
            so_path.exists(),
            "checked-in program artifact missing: {}",
            so_path.display()
        );

        let child = Command::new("solana-test-validator")
            .args(["--ledger"])
            .arg(ledger.path())
            .args(["--rpc-port", &rpc_port.to_string()])
            .args(["--faucet-port", &(rpc_port + 1).to_string()])
            .args([
                "--dynamic-port-range",
                &format!("{}-{}", rpc_port + 2, rpc_port + 40),
            ])
            .args([
                "--bpf-program",
                connector_settlement_solana_program::PROGRAM_ID,
            ])
            .arg(&so_path)
            .args(["--reset", "--quiet"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect(
                "spawn solana-test-validator (is it on PATH? see \
                 https://docs.anza.xyz/cli/install)",
            );

        let rpc = RpcClient::new(rpc_url.clone());
        let mut ready = false;
        for _ in 0..600 {
            if rpc.get_version().await.is_ok() {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            ready,
            "solana-test-validator did not become ready at {rpc_url}"
        );

        Self {
            child,
            ledger,
            rpc_url,
        }
    }
}

impl Drop for SolanaValidator {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // `ledger` is a TempDir and cleans up its directory on drop; kept
        // as a field purely so it outlives the validator process using it,
        // not read otherwise -- hence the `#![allow(dead_code)]` above.
        let _ = &self.ledger;
    }
}
