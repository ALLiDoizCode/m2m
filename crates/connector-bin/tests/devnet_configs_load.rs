//! Proves the devnet overlay's own committed `connector.toml` files
//! (issue #490, ADR 0013's parallel fleet) load and serve by the actual
//! compiled binary -- the first acceptance criterion, and per the issue's
//! own scope boundary, the only one this sandbox (no Docker, no
//! infrastructure credentials) can verify. Reachability of the peer or the
//! apps behind either route is explicitly NOT proven here.
//!
//! Reads the files exactly as committed and only substitutes what a real
//! deployment must also substitute: the bind addresses (fixed devnet ports
//! would flake or collide across parallel test runs -- every other test in
//! this crate binds `127.0.0.1:0` for the same reason), the signer key file
//! (real key material is never committed -- see `.gitignore`), and (issue
//! #542) the `[settlement]` section's `rpc_url`/`contract_address`/
//! `token_address` -- both committed files point at the real Base Sepolia
//! RPC and the real USDC token, which this sandboxed test has no route to,
//! so `build()`'s real `EvmSettlementBackend::connect` needs a real chain
//! it CAN reach: a disposable local `anvil`, exactly like this crate's
//! settlement-carrying config already spawns for `connector-cli` and
//! `connector-operator`'s own tests. Everything else -- prefixes, routes,
//! peer id/addr -- is the literal committed content.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

use connector_settlement_evm::EvmSettlementBackend;

const APEX_CONFIG: &str = include_str!("../../../infra/linode-node/connector-rust.toml");
const STORE_CONFIG: &str = include_str!("../../../infra/linode-store/connector-rust.toml");

const DEPLOYER_PRIVATE_KEY: &str =
    "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

fn anvil_available() -> bool {
    Command::new("anvil")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Same "fail loudly in CI, skip locally" gate `connector-settlement-evm`'s
/// own `support::require_anvil` uses (issue #471) -- a real chain is
/// genuinely under test here.
fn require_anvil() -> bool {
    if anvil_available() {
        return true;
    }
    if std::env::var_os("CI").is_some() {
        panic!(
            "anvil is not on PATH, but CI is set -- the Rust Workspace Gate must install \
             Foundry before this test runs. Refusing to silently skip and report success."
        );
    }
    eprintln!(
        "skipping: anvil is not on PATH (install Foundry: https://getfoundry.sh) -- this test \
         needs a real chain and only skips because this is not a CI run"
    );
    false
}

struct Anvil {
    child: Child,
    rpc_url: String,
}

static NEXT_PORT_OFFSET: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

impl Anvil {
    async fn spawn() -> Self {
        let offset = NEXT_PORT_OFFSET.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let port = 18_500u16
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
                "1",
                "--balance",
                "10000",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn anvil");

        use ethers::providers::{Http, Middleware, Provider};
        let provider = Provider::<Http>::try_from(rpc_url.as_str()).expect("provider");
        for _ in 0..200 {
            if provider.get_chainid().await.is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        Self { child, rpc_url }
    }
}

impl Drop for Anvil {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn write_raw_key_file() -> tempfile::NamedTempFile {
    let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
    key_file
        .write_all(&[9u8; 32])
        .expect("write raw 32-byte key");
    key_file
}

/// Substitute the config values that cannot be committed or cannot be
/// reached from a sandboxed test: the signer key path, the bind addresses,
/// and (issue #542) the `[settlement]` section's `rpc_url`,
/// `contract_address` and `token_address` -- pointed instead at a real,
/// disposable, freshly deployed local chain. Every other line -- prefixes,
/// handler URLs, peer id/addr, `decimals` -- is the literal committed
/// content.
fn with_test_addresses(
    raw: &str,
    key_path: &std::path::Path,
    anvil_rpc_url: &str,
    contract_address: ethers::types::Address,
    token_address: ethers::types::Address,
) -> String {
    raw.replace(
        "key_file = \"/app/data/signer.key\"",
        &format!("key_file = \"{}\"", key_path.display()),
    )
    .replace(
        "client_edge_addr = \"0.0.0.0:4000\"",
        "client_edge_addr = \"127.0.0.1:0\"",
    )
    .replace(
        "peer_wire_addr = \"0.0.0.0:4001\"",
        "peer_wire_addr = \"127.0.0.1:0\"",
    )
    .replace(
        "rpc_url = \"https://base-sepolia-rpc.publicnode.com\"",
        &format!("rpc_url = \"{anvil_rpc_url}\""),
    )
    .replace(
        "contract_address = \"0x0000000000000000000000000000000000000000\"",
        &format!("contract_address = \"{contract_address:?}\""),
    )
    .replace(
        "token_address = \"0x49beE1Bca5d15Fb0963117923403F9498119a9Ce\"",
        &format!("token_address = \"{token_address:?}\""),
    )
}

fn write_config(text: &str) -> tempfile::NamedTempFile {
    let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
    write!(config_file, "{text}").expect("write config file");
    config_file
}

fn spawn(config_path: &std::path::Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_connector"))
        .arg(config_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn connector binary")
}

/// Reads stdout lines until both `"connector listening"` and (if
/// `expect_peer_wire`) `"peer wire listening"` have been seen, or the
/// process exits first -- which fails the assertion below with whatever the
/// process actually printed, rather than hanging.
fn wait_for_listen_lines(child: &mut Child, expect_peer_wire: bool) {
    let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
    let mut saw_client_edge = false;
    let mut saw_peer_wire = false;
    let mut line = String::new();
    loop {
        line.clear();
        let read = stdout.read_line(&mut line).expect("read stdout");
        assert!(read > 0, "process exited before logging a listen address");
        if line.contains("connector listening") {
            saw_client_edge = true;
        }
        if line.contains("peer wire listening") {
            saw_peer_wire = true;
        }
        if saw_client_edge && (!expect_peer_wire || saw_peer_wire) {
            return;
        }
    }
}

#[tokio::test]
async fn the_apex_relay_side_devnet_config_loads_and_serves() {
    if !require_anvil() {
        return;
    }
    assert!(APEX_CONFIG.contains("g.rust.relay"));
    assert!(APEX_CONFIG.contains("g.rust.store"));

    let anvil = Anvil::spawn().await;
    let token =
        EvmSettlementBackend::deploy_mock_token(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
            .await
            .expect("deploy mock USDC");
    let settlement = EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
        .await
        .expect("deploy SettlementChannel");
    let contract_address = settlement.address();
    drop(settlement);

    let key_file = write_raw_key_file();
    let config_file = write_config(&with_test_addresses(
        APEX_CONFIG,
        key_file.path(),
        &anvil.rpc_url,
        contract_address,
        token,
    ));

    let mut child = spawn(config_file.path());
    // No peer_wire_addr in this file (the apex only dials out) -- only the
    // client edge is expected to log a listen line.
    wait_for_listen_lines(&mut child, false);

    child.kill().expect("kill connector");
    child.wait().expect("wait for connector to exit");
}

#[tokio::test]
async fn the_store_side_devnet_config_loads_and_serves() {
    if !require_anvil() {
        return;
    }
    assert!(STORE_CONFIG.contains("g.rust.store"));

    let anvil = Anvil::spawn().await;
    let token =
        EvmSettlementBackend::deploy_mock_token(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
            .await
            .expect("deploy mock USDC");
    let settlement = EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
        .await
        .expect("deploy SettlementChannel");
    let contract_address = settlement.address();
    drop(settlement);

    let key_file = write_raw_key_file();
    let config_file = write_config(&with_test_addresses(
        STORE_CONFIG,
        key_file.path(),
        &anvil.rpc_url,
        contract_address,
        token,
    ));

    let mut child = spawn(config_file.path());
    // This file configures peer_wire_addr (it accepts the apex's
    // connection), so both listeners must come up.
    wait_for_listen_lines(&mut child, true);

    child.kill().expect("kill connector");
    child.wait().expect("wait for connector to exit");
}
