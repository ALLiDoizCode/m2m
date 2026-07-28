//! Proves the devnet overlay's own committed `connector.toml` files
//! (issue #490, ADR 0013's parallel fleet) load and serve by the actual
//! compiled binary -- the first acceptance criterion, and per the issue's
//! own scope boundary, the only one this sandbox (no Docker, no
//! infrastructure credentials) can verify. Reachability of the peer or the
//! apps behind either route is explicitly NOT proven here.
//!
//! There are two cases per file, and they prove different things.
//!
//! **Verbatim** (`*_devnet_config_loads_and_serves_verbatim`) boots the file
//! exactly as committed, substituting only what this sandbox physically
//! cannot supply: the signer key file (real key material is never committed
//! -- see `.gitignore`, and config load refuses a `key_file` that is not
//! there) and the bind addresses (fixed devnet ports would flake or collide
//! across parallel test runs -- every other test in this crate binds
//! `127.0.0.1:0` for the same reason). Nothing semantic is touched: no
//! prefix, no route, no peer, and in particular no `[settlement]` value.
//! This is the property a reader assumes this file provides, and the only
//! case that catches a committed config which cannot start. Exactly that
//! happened: a `[settlement]` section naming the zero address made both
//! files exit 1 on startup, because `EvmSettlementBackend::connect` reads
//! `token()` off the address it is given and there is no contract at that
//! one (issue #542). Both files now ship that section commented out.
//!
//! **Template** (`*_devnet_settlement_template_boots_against_a_deployed_contract`)
//! takes the commented-out `[settlement]` block each file carries between
//! its `BEGIN`/`END` template markers, uncomments it, points `rpc_url` and
//! `contract_address` at a freshly deployed contract on a disposable local
//! `anvil`, and boots that. Documented config shapes rot; this keeps the
//! shape an operator is told to fill in one that demonstrably works, and
//! keeps `runtime::build`'s settlement construction path covered end to end
//! by the real binary. It is skipped when no `anvil` is on `PATH`.
//!
//! If a real `SettlementChannel` is ever deployed and its address recorded
//! in these files, the verbatim case starts requiring a reachable chain in
//! order to pass. That is a decision to revisit here deliberately, not an
//! accident to paper over: a committed `[settlement]` section means the node
//! cannot start without that chain, which is the fail-closed behaviour
//! ADR 0009 asks for.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

use connector_settlement_evm::test_support::{require_anvil, Anvil, DEPLOYER_PRIVATE_KEY};
use connector_settlement_evm::EvmSettlementBackend;

const APEX_CONFIG: &str = include_str!("../../../infra/linode-node/connector-rust.toml");
const STORE_CONFIG: &str = include_str!("../../../infra/linode-store/connector-rust.toml");

/// This test binary's own base port for [`Anvil::spawn`] -- distinct from
/// other test binaries' bases (`connector-settlement-evm`'s own tests use
/// 18_600; `connector-cli`'s use 18_700/18_800) so that binaries running
/// concurrently under `cargo test --workspace` don't contend for the same
/// port range.
const ANVIL_BASE_PORT: u16 = 18_500;

/// The markers each committed file wraps its commented-out `[settlement]`
/// block in, so [`uncomment_settlement_template`] can find the block without
/// depending on prose that is free to be reworded.
const TEMPLATE_BEGIN: &str = "# --- BEGIN settlement template";
const TEMPLATE_END: &str = "# --- END settlement template";

fn write_raw_key_file() -> tempfile::NamedTempFile {
    let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
    key_file
        .write_all(&[9u8; 32])
        .expect("write raw 32-byte key");
    key_file
}

/// `str::replace`, but a pattern that matches nothing is a test failure
/// rather than a silent no-op -- otherwise renaming a line in a committed
/// file would quietly turn one of the substitutions below into nothing at
/// all, and the test would go on passing while testing something else.
fn replace_expecting_a_match(raw: &str, from: &str, to: &str) -> String {
    assert!(
        raw.contains(from),
        "expected to find `{from}` in the committed config text -- if that \
         line was renamed, update this test rather than letting the \
         substitution silently do nothing"
    );
    raw.replace(from, to)
}

/// Substitute only what this sandbox physically cannot supply: the signer
/// key file (real key material is never committed) and the bind addresses
/// (fixed ports collide across parallel test runs). Every other line --
/// prefixes, handler URLs, peer id/addr, and every `[settlement]` value --
/// stays the literal committed content.
///
/// `peer_wire_addr` is substituted only where the file has one (the apex
/// only dials out and sets none), so that one alone is not asserted on.
fn with_sandbox_paths(raw: &str, key_path: &std::path::Path) -> String {
    let replaced = replace_expecting_a_match(
        raw,
        "key_file = \"/app/data/signer.key\"",
        &format!("key_file = \"{}\"", key_path.display()),
    );
    let replaced = replace_expecting_a_match(
        &replaced,
        "client_edge_addr = \"0.0.0.0:4000\"",
        "client_edge_addr = \"127.0.0.1:0\"",
    );
    replaced.replace(
        "peer_wire_addr = \"0.0.0.0:4001\"",
        "peer_wire_addr = \"127.0.0.1:0\"",
    )
}

/// Uncomment the `[settlement]` block a committed file carries between its
/// `BEGIN`/`END` template markers, so the block an operator is told to fill
/// in is the block this test actually boots. A file with no such block is a
/// test failure: either the template was deleted (and this case has nothing
/// left to prove) or a real `[settlement]` section was committed (and the
/// verbatim case is the one that covers it).
fn uncomment_settlement_template(raw: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    let mut saw_template = false;
    for line in raw.lines() {
        if line.starts_with(TEMPLATE_BEGIN) {
            inside = true;
            saw_template = true;
            continue;
        }
        if line.starts_with(TEMPLATE_END) {
            inside = false;
            continue;
        }
        if inside {
            let uncommented = line
                .strip_prefix("# ")
                .or_else(|| line.strip_prefix('#'))
                .unwrap_or_else(|| {
                    panic!("line inside the settlement template is not a comment: {line}")
                });
            out.push_str(uncommented);
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    assert!(
        saw_template && !inside,
        "the committed config has no complete `{TEMPLATE_BEGIN}` / \
         `{TEMPLATE_END}` block -- see this file's module docs"
    );
    out
}

/// Point an uncommented `[settlement]` block at a real, disposable, freshly
/// deployed local chain. `chain`, `decimals` and the key location stay the
/// literal committed content.
fn with_anvil_settlement(
    raw: &str,
    anvil_rpc_url: &str,
    contract_address: ethers::types::Address,
    token_address: ethers::types::Address,
) -> String {
    let replaced = replace_expecting_a_match(
        raw,
        "rpc_url = \"https://base-sepolia-rpc.publicnode.com\"",
        &format!("rpc_url = \"{anvil_rpc_url}\""),
    );
    let replaced = replace_expecting_a_match(
        &replaced,
        "contract_address = \"0x0000000000000000000000000000000000000000\"",
        &format!("contract_address = \"{contract_address:?}\""),
    );
    replace_expecting_a_match(
        &replaced,
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
/// process exits first -- which fails with the exit status and whatever the
/// process printed on stderr, rather than hanging or reporting only that a
/// pipe closed.
fn wait_for_listen_lines(child: &mut Child, expect_peer_wire: bool) {
    let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
    let mut saw_client_edge = false;
    let mut saw_peer_wire = false;
    let mut line = String::new();
    loop {
        line.clear();
        let read = stdout.read_line(&mut line).expect("read stdout");
        if read == 0 {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                use std::io::Read;
                let _ = pipe.read_to_string(&mut stderr);
            }
            let status = child.wait().expect("wait for connector to exit");
            panic!(
                "the connector exited ({status}) before logging a listen \
                 address -- this config does not start. stderr:\n{stderr}"
            );
        }
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

fn boot_and_kill(config_text: &str, expect_peer_wire: bool) {
    let config_file = write_config(config_text);
    let mut child = spawn(config_file.path());
    wait_for_listen_lines(&mut child, expect_peer_wire);
    child.kill().expect("kill connector");
    child.wait().expect("wait for connector to exit");
}

#[tokio::test]
async fn the_apex_relay_side_devnet_config_loads_and_serves_verbatim() {
    assert!(APEX_CONFIG.contains("g.rust.relay"));
    assert!(APEX_CONFIG.contains("g.rust.store"));

    let key_file = write_raw_key_file();
    // No peer_wire_addr in this file (the apex only dials out) -- only the
    // client edge is expected to log a listen line.
    boot_and_kill(&with_sandbox_paths(APEX_CONFIG, key_file.path()), false);
}

#[tokio::test]
async fn the_store_side_devnet_config_loads_and_serves_verbatim() {
    assert!(STORE_CONFIG.contains("g.rust.store"));

    let key_file = write_raw_key_file();
    // This file configures peer_wire_addr (it accepts the apex's
    // connection), so both listeners must come up.
    boot_and_kill(&with_sandbox_paths(STORE_CONFIG, key_file.path()), true);
}

/// Deploy a fresh `SettlementChannel` and its mock USDC on a disposable
/// local chain. The returned [`Anvil`] must stay alive for as long as the
/// addresses beside it are used.
async fn deploy_settlement_on_anvil() -> (Anvil, ethers::types::Address, ethers::types::Address) {
    let anvil = Anvil::spawn(ANVIL_BASE_PORT).await;
    let token =
        EvmSettlementBackend::deploy_mock_token(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
            .await
            .expect("deploy mock USDC");
    let settlement = EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
        .await
        .expect("deploy SettlementChannel");
    let contract_address = settlement.address();
    drop(settlement);
    (anvil, contract_address, token)
}

#[tokio::test]
async fn the_apex_devnet_settlement_template_boots_against_a_deployed_contract() {
    if !require_anvil() {
        return;
    }
    let (anvil, contract_address, token) = deploy_settlement_on_anvil().await;

    let key_file = write_raw_key_file();
    let text = uncomment_settlement_template(APEX_CONFIG);
    let text = with_anvil_settlement(&text, &anvil.rpc_url, contract_address, token);
    let text = with_sandbox_paths(&text, key_file.path());

    boot_and_kill(&text, false);
}

#[tokio::test]
async fn the_store_devnet_settlement_template_boots_against_a_deployed_contract() {
    if !require_anvil() {
        return;
    }
    let (anvil, contract_address, token) = deploy_settlement_on_anvil().await;

    let key_file = write_raw_key_file();
    let text = uncomment_settlement_template(STORE_CONFIG);
    let text = with_anvil_settlement(&text, &anvil.rpc_url, contract_address, token);
    let text = with_sandbox_paths(&text, key_file.path());

    boot_and_kill(&text, true);
}
