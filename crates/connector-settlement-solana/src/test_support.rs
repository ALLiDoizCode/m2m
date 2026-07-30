//! A real, disposable `solana-test-validator` harness other crates' tests
//! reuse rather than reimplementing (issue #630): `connector-cli`'s own
//! settlement-construction tests need exactly what this crate's own
//! `tests/support/mod.rs` already provides for its own integration tests.
//! Gated behind the `test-util` feature for the same reason
//! `connector-settlement-evm`'s own `test_support` module is: a downstream
//! crate's tests cannot see anything behind `#[cfg(test)]`, since that cfg
//! is only active while this crate compiles its own test binary.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::pubkey::Pubkey;

/// Airdrop `pubkey` enough lamports to submit a handful of transactions
/// (issue #630) -- the shared "fund a freshly connected identity" step
/// every caller of this harness that goes on to sign real transactions
/// needs (`connector-cli`'s settlement-construction tests,
/// `connect_identity.rs`'s own), rather than each reimplementing the same
/// request-airdrop-then-poll-confirm loop.
pub async fn fund(rpc: &RpcClient, pubkey: &Pubkey) {
    let signature = rpc
        .request_airdrop(pubkey, 10_000_000_000)
        .await
        .expect("airdrop");
    for _ in 0..200 {
        if rpc.confirm_transaction(&signature).await.unwrap_or(false) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("airdrop did not confirm in time");
}

/// The fixed program id this crate's tests load `payment_channel.so`
/// under -- checked in at `deploy/payment_channel-keypair.json`, distinct
/// from the real, deployed `2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip`
/// on public devnet (`packages/solana-program/deployments/devnet-public.md`):
/// this id exists only inside a disposable local validator's genesis.
pub const LOCAL_TEST_PROGRAM_ID: &str = "HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR";

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("crates/connector-settlement-solana is two levels below the workspace root")
        .to_path_buf()
}

fn program_so_path() -> PathBuf {
    workspace_root().join("target/deploy/payment_channel.so")
}

/// Build `packages/solana-program` for the SBF target with `cargo
/// build-sbf` if its `.so` is not already present, so a fresh checkout (or
/// CI cache miss) still produces something to load -- mirrors `make
/// solana-build`. Returns `false` (rather than panicking) if the build
/// tool is missing or the build itself fails, so callers can fold that
/// into the same "skip locally, fail loudly in CI" policy every other gate
/// in this harness already uses.
fn ensure_program_built() -> bool {
    if program_so_path().exists() {
        return true;
    }
    let status = Command::new("cargo")
        .args(["build-sbf", "--tools-version", "v1.52"])
        .current_dir(workspace_root().join("packages/solana-program"))
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .status();
    matches!(status, Ok(status) if status.success()) && program_so_path().exists()
}

/// True if `solana-test-validator --version` runs successfully.
pub fn solana_test_validator_available() -> bool {
    Command::new("solana-test-validator")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// The Solana twin of `connector_settlement_evm::test_support::require_anvil`:
/// a real chain is genuinely under test here (ADR 0007), so a CI run
/// lacking either `solana-test-validator` or a buildable
/// `payment_channel.so` must fail loudly rather than silently skip and
/// report `passed`. A local run missing either still skips, since
/// requiring every contributor to install the Solana CLI and SBF toolchain
/// just to run `cargo test` is a real cost this crate doesn't need to
/// impose.
///
/// Returns `true` when the caller should proceed with its real assertions,
/// `false` when the caller should return early (having already skipped
/// gracefully via a printed message).
pub fn require_solana_test_validator() -> bool {
    let validator_ok = solana_test_validator_available();
    let program_ok = ensure_program_built();

    if validator_ok && program_ok {
        return true;
    }

    if std::env::var_os("CI").is_some() {
        panic!(
            "solana-test-validator on PATH: {validator_ok}, packages/solana-program built (or \
             buildable via `cargo build-sbf`): {program_ok} -- the Rust Workspace Gate must \
             provide both before this crate's tests run. Refusing to silently skip and report \
             success here; see issue #567."
        );
    }

    eprintln!(
        "skipping: solana-test-validator on PATH: {validator_ok}, packages/solana-program built \
         (or buildable via `cargo build-sbf`, requires the Solana SBF toolchain: \
         https://docs.anza.xyz/cli/install): {program_ok} -- this test needs a real chain \
         running the real deployed program and only skips because this is not a CI run"
    );
    false
}

static NEXT_PORT_OFFSET: AtomicU16 = AtomicU16::new(0);

/// A freshly spawned `solana-test-validator` instance, with
/// `packages/solana-program`'s own built `.so` loaded into its genesis at
/// [`LOCAL_TEST_PROGRAM_ID`], killed (and its disposable ledger directory
/// removed) when dropped. Each instance gets its own ledger directory and
/// ports so tests spawning one concurrently don't collide.
pub struct SolanaValidator {
    child: Child,
    // Never read after construction -- kept only so its directory outlives
    // the validator process using it and is removed on drop.
    _ledger: tempfile::TempDir,
    pub rpc_url: String,
}

impl SolanaValidator {
    pub async fn spawn() -> Self {
        let offset = NEXT_PORT_OFFSET.fetch_add(1, Ordering::SeqCst);
        let rpc_port = 19_900u16
            .wrapping_add((std::process::id() as u16) % 500)
            .wrapping_add(offset.wrapping_mul(50));
        let rpc_url = format!("http://127.0.0.1:{rpc_port}");
        let ledger = tempfile::tempdir().expect("create disposable ledger dir");

        let so_path = program_so_path();
        assert!(
            so_path.exists(),
            "packages/solana-program's built artifact missing: {} -- \
             require_solana_test_validator() must be checked first",
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
            .args(["--bpf-program", LOCAL_TEST_PROGRAM_ID])
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
            _ledger: ledger,
            rpc_url,
        }
    }
}

impl Drop for SolanaValidator {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
