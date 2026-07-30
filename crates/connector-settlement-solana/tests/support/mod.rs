//! Shared support for connector-settlement-solana's integration tests: a
//! `solana-test-validator` with `packages/solana-program`'s own built
//! `payment_channel.so` loaded into its genesis, at the fixed local-test
//! program id checked in at `crates/connector-settlement-solana/deploy/`
//! (issue #567 -- the Solana twin of `connector-settlement-evm`'s own
//! `tests/support/mod.rs`, and this crate's replacement for the deleted
//! `connector-settlement-solana-program` crate's checked-in `.so`).

#![allow(dead_code)]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use solana_client::nonblocking::rpc_client::RpcClient;

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
///
/// `--tools-version v1.52` pins the platform-tools release rather than
/// taking whichever line the installed CLI defaults to: it is the same pin
/// CI's own `solana-program` job builds with
/// (`.github/workflows/ci.yml`), and the toolchain line the deployed
/// devnet program itself was built from -- a v1.52 build of this source
/// matches the live bytecode's exact size and is 99.7% byte-identical,
/// where the v2.1 CLI's default tools line produces a differently-sized
/// binary entirely (`packages/solana-program/deployments/devnet-public.md`,
/// "Reproducible-build comparison").
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

/// The Solana twin of `connector-settlement-evm`'s `require_anvil`: a real
/// chain is genuinely under test here (ADR 0007), so a CI run lacking
/// either `solana-test-validator` or a buildable `payment_channel.so` must
/// fail loudly rather than silently skip and report `passed` (issue #428,
/// carried forward by issue #567's retarget). A local run missing either
/// still skips, since requiring every contributor to install the Solana
/// CLI and SBF toolchain just to run `cargo test` is a real cost this
/// crate doesn't need to impose.
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
    ledger: tempfile::TempDir,
    pub rpc_url: String,
}

impl SolanaValidator {
    pub async fn spawn() -> Self {
        let offset = NEXT_PORT_OFFSET.fetch_add(1, Ordering::SeqCst);
        let rpc_port = 19_400u16
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
