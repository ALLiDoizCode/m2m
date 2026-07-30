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
//! there), the bind addresses (fixed devnet ports would flake or collide
//! across parallel test runs -- every other test in this crate binds
//! `127.0.0.1:0` for the same reason), and `state_dir` (a container path
//! this host cannot create -- but the line itself must still be there,
//! issue #605). Nothing semantic is touched: no
//! prefix, no route, no peer, no `price`, and in particular no
//! `[settlement]` value. This is the property a reader assumes this file
//! provides, and the only case that catches a committed config which cannot
//! start. Exactly that happened: a `[settlement]` section naming the zero
//! address made both files exit 1 on startup, because
//! `EvmSettlementBackend::connect` resolves a `TokenNetwork` through the
//! configured `TokenNetworkRegistry` and there is no contract at that one
//! (issue #542, issue #576). Both files now ship that section commented
//! out.
//!
//! The verbatim case also drives one claimless request at each file's own
//! terminating route and asserts it is answered with the x402 greeting
//! (#552) naming the committed `price`, rather than served for nothing.
//! Both files priced that route at `0` while the greeting had already
//! landed, so a deployed box was still an open free gateway (issue #557);
//! because the price is read off the committed text like everything else
//! here, this fails again if either file ever silently returns to zero.
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
//! If a real `TokenNetworkRegistry` is ever deployed and its address
//! recorded in these files, the verbatim case starts requiring a reachable
//! chain in order to pass. That is a decision to revisit here deliberately, not an
//! accident to paper over: a committed `[settlement]` section means the node
//! cannot start without that chain, which is the fail-closed behaviour
//! ADR 0009 asks for.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

use chrono::{Duration as ChronoDuration, Utc};
use connector_domain::{derive_condition, EnvelopeRequest, Prepare};
use connector_settlement_evm::test_support::{require_anvil, Anvil, DEPLOYER_PRIVATE_KEY};
use connector_settlement_evm::EvmSettlementBackend;

mod support;
use support::{parse_json_log_addr, write_config, write_raw_key_file};

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

/// The `price` both committed files put on their terminating route, and so
/// the amount the x402 greeting must quote. Deliberately a literal rather
/// than something parsed back out of the file under test: a test that read
/// the expected value from the thing it is testing would keep passing if
/// that value went back to `0`, which is exactly the regression issue #557
/// exists to prevent. Parity with the TypeScript fleet's `price: '1000'` on
/// the same box (`infra/linode-node/connector.yaml`).
const EXPECTED_PRICE: u64 = 1000;

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
/// key file (real key material is never committed), the bind addresses
/// (fixed ports collide across parallel test runs) and `state_dir` (the
/// committed value is a container path, `/app/state`, which no test host
/// can create). Every other line -- prefixes, handler URLs, peer id/addr,
/// `price`, and every `[settlement]` value -- stays the literal committed
/// content.
///
/// The `state_dir` substitution is a path swap, not a removal: the
/// committed files must keep naming one, since a devnet box without it
/// would hold its claim watermarks in memory and forget every spent claim
/// on restart (issue #605). `replace_expecting_a_match` is what makes that
/// load-bearing -- deleting the line from either config fails this test
/// rather than silently testing a node with no durable state.
///
/// `peer_wire_addr` is substituted only where the file has one (the apex
/// only dials out and sets none), so that one alone is not asserted on.
fn with_sandbox_paths(
    raw: &str,
    key_path: &std::path::Path,
    state_dir: &std::path::Path,
) -> String {
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
    let replaced = replace_expecting_a_match(
        &replaced,
        "state_dir = \"/app/state\"",
        &format!("state_dir = \"{}\"", state_dir.display()),
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

fn spawn(config_path: &std::path::Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_connector"))
        .arg(config_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn connector binary")
}

/// Reads stdout lines until both `"connector listening"` and (if
/// `expect_peer_wire`) `"peer wire listening"` have been seen, returning the
/// client edge's actual bound address; or the process exits first -- which
/// fails with the exit status and whatever the process printed on stderr,
/// rather than hanging or reporting only that a pipe closed.
fn wait_for_listen_lines(child: &mut Child, expect_peer_wire: bool) -> String {
    let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
    let mut client_edge_addr: Option<String> = None;
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
            client_edge_addr = Some(parse_json_log_addr(&line));
        }
        if line.contains("peer wire listening") {
            saw_peer_wire = true;
        }
        if let Some(addr) = &client_edge_addr {
            if !expect_peer_wire || saw_peer_wire {
                return addr.clone();
            }
        }
    }
}

/// A booted connector, killed and reaped on drop -- so a test that panics
/// midway leaves no orphaned process behind -- holding its config file alive
/// for as long as the process is.
struct BootedConnector {
    child: Child,
    client_edge_addr: String,
    _config_file: tempfile::NamedTempFile,
}

impl Drop for BootedConnector {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn boot(config_text: &str, expect_peer_wire: bool) -> BootedConnector {
    let config_file = write_config(config_text);
    let mut child = spawn(config_file.path());
    let client_edge_addr = wait_for_listen_lines(&mut child, expect_peer_wire);
    BootedConnector {
        child,
        client_edge_addr,
        _config_file: config_file,
    }
}

/// A claimless PREPARE addressed to `destination` -- no `ILP-Payment-Channel-
/// Claim`/`-Wrapped` header exists on this HTTP request, matching what any
/// real unpaying sender would send. The envelope body is irrelevant: a
/// priced route answers with terms before ever decoding it as work for the
/// app (issue #526).
fn unpaid_prepare(destination: &str) -> Prepare {
    Prepare {
        amount: 0,
        expires_at: Utc::now() + ChronoDuration::minutes(5),
        execution_condition: derive_condition(&[0u8; 32]),
        destination: destination.to_string(),
        data: EnvelopeRequest {
            method: "POST".to_string(),
            target: "/".to_string(),
            headers: vec![],
            body: vec![],
        }
        .encode(),
    }
}

/// Issue #557's core proof: a claimless request to `destination` on a node
/// started from a committed devnet config is answered with the x402
/// greeting (HTTP 402, terms naming [`EXPECTED_PRICE`]) instead of being
/// forwarded to the app -- the free-gateway failure mode this issue closes.
async fn assert_answered_with_x402_greeting(client_edge_addr: &str, destination: &str) {
    let response = reqwest::Client::new()
        .post(format!("http://{client_edge_addr}/ilp"))
        .body(unpaid_prepare(destination).encode())
        .send()
        .await
        .expect("POST /ilp");
    assert_eq!(
        response.status(),
        reqwest::StatusCode::PAYMENT_REQUIRED,
        "a claimless request to a priced route must be greeted, not served"
    );
    let terms: serde_json::Value = response.json().await.expect("x402 JSON terms");
    assert_eq!(
        terms["accepts"][0]["amount"],
        EXPECTED_PRICE.to_string(),
        "greeted price must match the route's committed `price`"
    );
}

#[tokio::test]
async fn the_apex_relay_side_devnet_config_loads_and_serves_verbatim() {
    assert!(APEX_CONFIG.contains("g.toon.relay"));
    assert!(APEX_CONFIG.contains("g.toon.store"));

    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    // No peer_wire_addr in this file (the apex only dials out) -- only the
    // client edge is expected to log a listen line.
    let connector = boot(
        &with_sandbox_paths(APEX_CONFIG, key_file.path(), state_dir.path()),
        false,
    );

    assert_answered_with_x402_greeting(&connector.client_edge_addr, "g.toon.relay").await;
}

#[tokio::test]
async fn the_store_side_devnet_config_loads_and_serves_verbatim() {
    assert!(STORE_CONFIG.contains("g.toon.store"));

    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    // This file configures peer_wire_addr (it accepts the apex's
    // connection), so both listeners must come up.
    let connector = boot(
        &with_sandbox_paths(STORE_CONFIG, key_file.path(), state_dir.path()),
        true,
    );

    assert_answered_with_x402_greeting(&connector.client_edge_addr, "g.toon.store").await;
}

/// Deploy a fresh `TokenNetworkRegistry`, a `TokenNetwork` through it, and
/// its mock USDC on a disposable local chain. The returned [`Anvil`] must
/// stay alive for as long as the addresses beside it are used.
async fn deploy_settlement_on_anvil() -> (Anvil, ethers::types::Address, ethers::types::Address) {
    let anvil = Anvil::spawn(ANVIL_BASE_PORT).await;
    let token =
        EvmSettlementBackend::deploy_mock_token(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
            .await
            .expect("deploy mock USDC");
    let settlement = EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
        .await
        .expect("deploy a TokenNetwork through a fresh registry");
    let registry_address = settlement.registry_address();
    drop(settlement);
    (anvil, registry_address, token)
}

#[tokio::test]
async fn the_apex_devnet_settlement_template_boots_against_a_deployed_contract() {
    if !require_anvil() {
        return;
    }
    let (anvil, contract_address, token) = deploy_settlement_on_anvil().await;

    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let text = uncomment_settlement_template(APEX_CONFIG);
    let text = with_anvil_settlement(&text, &anvil.rpc_url, contract_address, token);
    let text = with_sandbox_paths(&text, key_file.path(), state_dir.path());

    drop(boot(&text, false));
}

#[tokio::test]
async fn the_store_devnet_settlement_template_boots_against_a_deployed_contract() {
    if !require_anvil() {
        return;
    }
    let (anvil, contract_address, token) = deploy_settlement_on_anvil().await;

    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let text = uncomment_settlement_template(STORE_CONFIG);
    let text = with_anvil_settlement(&text, &anvil.rpc_url, contract_address, token);
    let text = with_sandbox_paths(&text, key_file.path(), state_dir.path());

    drop(boot(&text, true));
}
