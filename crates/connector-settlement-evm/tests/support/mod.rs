//! A real, disposable `anvil` instance for this crate's integration tests
//! -- no docker, no `make anvil-up`: spawned directly as a child process
//! (this sandbox has no docker daemon, and Foundry's `anvil` binary is
//! what `docker compose --profile evm up` itself runs internally anyway).
//! Install with `foundryup` (https://getfoundry.sh) if `anvil` is not on
//! `PATH`; every test using this harness skips itself (rather than
//! failing the gate) when it is not, matching the precedent
//! `solana-provider.test.ts`/`connector-http-client-rust-e2e.test.ts` set
//! for gating on an external toolchain's build artifact.

use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use ethers::providers::{Http, Middleware, Provider};

/// Anvil's first well-known dev account -- the same one
/// `packages/contracts/script/DeployLocal.s.sol` already uses as its
/// deployer, so this test harness's choice of key is not a new
/// convention.
pub const DEPLOYER_PRIVATE_KEY: &str =
    "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

static NEXT_PORT_OFFSET: AtomicU16 = AtomicU16::new(0);

pub fn anvil_available() -> bool {
    Command::new("anvil")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// A freshly spawned `anvil` instance, killed when dropped. Each instance
/// gets its own port so tests spawning one concurrently don't collide.
pub struct Anvil {
    child: Child,
    pub rpc_url: String,
}

impl Anvil {
    pub async fn spawn() -> Self {
        let offset = NEXT_PORT_OFFSET.fetch_add(1, Ordering::SeqCst);
        let port = 18_600u16
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
