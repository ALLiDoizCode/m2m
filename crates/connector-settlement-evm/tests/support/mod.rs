//! Shared support for connector-settlement-evm's integration tests: whether `anvil` is on
//! `PATH`, and the CI-vs-local policy for what to do when it is not (issue #471).

// Each integration-test binary compiles this module separately and uses a
// different subset of it -- `anvil_gate_smoke` needs only `require_anvil`,
// while `contract_suite` and `gas_and_nonce` need the `Anvil` harness. Under
// clippy's `-D warnings` on `--all-targets`, whatever a given binary does not
// touch is a hard `dead_code` error, so the standard shared-support-module
// allow is required here rather than optional.
#![allow(dead_code)]

/// True if `<cmd> --version` runs successfully.
fn command_version_check(cmd: &str) -> bool {
    Command::new(cmd)
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// True if `anvil --version` runs successfully.
pub fn anvil_available() -> bool {
    command_version_check("anvil")
}

/// The one place every anvil-gated test asks "do I have a chain to talk to, and if not, is
/// that acceptable right now". A real chain is genuinely under test here (ADR 0007), so a CI
/// run that lacks `anvil` must fail loudly rather than silently skip and report `passed` --
/// that combination is worse than the test not existing, because it reports success. `CI` is
/// set by GitHub Actions (and effectively every other CI system) for every job, so gating on
/// it -- rather than a bespoke `REQUIRE_ANVIL` variable nobody remembers to set -- means a
/// fresh CI job fails by default. A local run without Foundry installed still skips, since
/// requiring every contributor to install Foundry just to run `cargo test` is a real cost this
/// crate doesn't need to impose.
///
/// Returns `true` when the caller should proceed with its real assertions, `false` when the
/// caller should return early (having already skipped gracefully via a printed message).
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

/// True if `forge --version` runs successfully.
pub fn forge_available() -> bool {
    command_version_check("forge")
}

/// The `forge` twin of [`require_anvil`], for tests that build
/// `packages/contracts` rather than talk to a running chain (issue #572's
/// ABI-provenance check). Same CI-vs-local policy: a fresh CI job installs
/// Foundry (see `.github/workflows/ci.yml`'s `rust-gate` job) and must
/// fail loudly rather than silently skip if that install regresses; a
/// local run without Foundry just skips.
pub fn require_forge() -> bool {
    if forge_available() {
        return true;
    }

    if std::env::var_os("CI").is_some() {
        panic!(
            "forge is not on PATH, but CI is set -- the Rust Workspace Gate must install \
             Foundry (foundry-rs/foundry-toolchain) before this crate's tests run. Refusing to \
             silently skip and report success here; see issue #471's precedent for anvil."
        );
    }

    eprintln!(
        "skipping: forge is not on PATH (install Foundry: https://getfoundry.sh) -- this test \
         builds packages/contracts and only skips because this is not a CI run"
    );
    false
}

use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use ethers::providers::{Http, Middleware, Provider};
use libsecp256k1::{Message, SecretKey};

/// `Anvil::spawn`'s own default chain id (`--chain-id 31337` above), and so
/// the EIP-712 domain a claim against its deployed `TokenNetwork` must be
/// signed under.
pub const ANVIL_CHAIN_ID: u64 = 31_337;

/// The inverse of `EvmSettlementBackend`'s own `format_channel_id` --
/// `TokenNetwork`'s channel id as the `[u8; 32]` an `EvmBalanceProof` signs
/// over.
pub fn channel_id_bytes(id: &str) -> [u8; 32] {
    let hex_digits = id.trim_start_matches("0x");
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex_digits[i * 2..i * 2 + 2], 16)
            .expect("channel id is 0x-prefixed 64-hex");
    }
    out
}

/// Sign `digest` exactly the way the production peer-wire/client-edge
/// signing path does (`connector_signer::crypto::sign_digest`): a 65-byte
/// `r || s || v` signature with `v` in libsecp256k1's raw `{0, 1}` range,
/// *not* the `{27, 28}` an EVM wallet would append. `EvmSettlementBackend`
/// itself normalizes that before submitting to `claimFromChannel` (issue
/// #590) -- a test signing the wallet range here would paper over that
/// normalization never being exercised.
pub fn sign_evm(secret: &SecretKey, digest: &[u8; 32]) -> Vec<u8> {
    let message = Message::parse(digest);
    let (signature, recovery_id) = libsecp256k1::sign(&message, secret);
    let mut bytes = signature.serialize().to_vec();
    let recovery_byte: u8 = recovery_id.into();
    bytes.push(recovery_byte);
    bytes
}

/// Anvil's first well-known dev account -- the same one
/// `packages/contracts/script/DeployLocal.s.sol` already uses as its
/// deployer, so this test harness's choice of key is not a new
/// convention.
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
