//! Shared support for connector-client-edge's real-chain integration test
//! (issue #522): whether `anvil` is on `PATH`, and the CI-vs-local policy
//! for what to do when it is not. This is `connector-settlement-evm/tests/support/mod.rs`'s
//! `require_anvil`/`Anvil` harness, duplicated per that crate's own
//! documented convention (each integration-test crate carries its own
//! copy) rather than shared as a library dependency.
#![allow(dead_code)]

use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use ethers::providers::{Http, Middleware, Provider};

/// True if `anvil --version` runs successfully.
pub fn anvil_available() -> bool {
    Command::new("anvil")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// The one place this crate's anvil-gated test asks "do I have a chain to
/// talk to, and if not, is that acceptable right now". See
/// `connector-settlement-evm/tests/support/mod.rs` for the full rationale
/// (ADR 0007, issue #471): a real chain is genuinely under test here, so a
/// CI run missing `anvil` fails loudly rather than silently skipping and
/// reporting `passed`; a local run without Foundry installed skips.
pub fn require_anvil() -> bool {
    if anvil_available() {
        return true;
    }

    if std::env::var_os("CI").is_some() {
        panic!(
            "anvil is not on PATH, but CI is set -- the Rust Workspace Gate must install \
             Foundry (foundry-rs/foundry-toolchain) before this crate's tests run. Refusing to \
             silently skip and report success here; see issue #471."
        );
    }

    eprintln!(
        "skipping: anvil is not on PATH (install Foundry: https://getfoundry.sh) -- this test \
         needs a real chain and only skips because this is not a CI run"
    );
    false
}

/// Anvil's first well-known dev account -- the same one
/// `connector-settlement-evm`'s own test harness uses as its deployer.
pub const DEPLOYER_PRIVATE_KEY: &str =
    "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

static NEXT_PORT_OFFSET: AtomicU16 = AtomicU16::new(0);

/// A freshly spawned `anvil` instance, killed when dropped. Each instance
/// gets its own port so tests spawning one concurrently don't collide.
pub struct Anvil {
    child: Child,
    pub rpc_url: String,
}

impl Anvil {
    pub async fn spawn() -> Self {
        let offset = NEXT_PORT_OFFSET.fetch_add(1, Ordering::SeqCst);
        // A distinct port range from connector-settlement-evm's own
        // harness (18_600+) so the two crates' test suites never collide
        // if ever run concurrently against the same machine.
        let port = 18_900u16
            .wrapping_add((std::process::id() as u16) % 1_000)
            .wrapping_add(offset);
        let rpc_url = format!("http://127.0.0.1:{port}");

        let child = Command::new("anvil")
            .args(["--host", "127.0.0.1", "--port"])
            .arg(port.to_string())
            .args([
                "--chain-id",
                "31337",
                "--accounts",
                "2",
                "--balance",
                "10000",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn anvil (is `anvil` on PATH? see foundryup)");

        let provider = Provider::<Http>::try_from(rpc_url.as_str()).expect("build provider");
        let mut ready = false;
        for _ in 0..200 {
            if provider.get_chainid().await.is_ok() {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(ready, "anvil did not become ready at {rpc_url}");

        Self { child, rpc_url }
    }
}

impl Drop for Anvil {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
