//! Proves the devnet overlay's own committed `connector.toml` files
//! (issue #490, ADR 0013's parallel fleet) load and serve by the actual
//! compiled binary -- the first acceptance criterion, and per the issue's
//! own scope boundary, the only one this sandbox (no Docker, no
//! infrastructure credentials) can verify. Reachability of the peer or the
//! apps behind either route is explicitly NOT proven here.
//!
//! There are two cases per file (three for the apex), and they prove
//! different things.
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
//! prefix, no route, no peer, no `price`. This is the property a reader
//! assumes this file provides, and the only case that catches a committed
//! config which cannot start. Exactly that happened: a `[settlement]`
//! section naming the zero address made both files exit 1 on startup,
//! because `EvmSettlementBackend::connect` resolves a `TokenNetwork`
//! through the configured `TokenNetworkRegistry` and there is no contract
//! at that one (issue #542, issue #576).
//!
//! One more substitution joined that list when the apex file's
//! `[settlement]` section went LIVE against Base Sepolia (#577; the store
//! file still ships the commented template): a committed live section
//! means the node cannot start without reaching that chain -- the
//! fail-closed behaviour ADR 0009 asks for, and exactly the network
//! dependency a test must not have. So the verbatim case boots the apex
//! file with its live settlement sections STRIPPED
//! ([`without_live_settlement`]), and those sections are proven by the two
//! cases described below. This was module-doc'd here as "a decision to
//! revisit deliberately" before #577 shipped; this is that decision.
//!
//! Since #645 the apex file carries issue #628's KEYED per-chain shape --
//! `[settlement.evm]` + `[settlement.evm.key]` and `[settlement.solana]` +
//! `[settlement.solana.key]` -- in place of the single flat `[settlement]`
//! (`chain = "evm"`) table. That migration is precisely the drift this
//! module exists to catch, and it caught it: [`without_live_settlement`]
//! looked for a literal `"\n[settlement]\n"` that no longer existed, and
//! the anvil case knew nothing of the second key file, so both apex cases
//! failed against the committed config. They are keyed off the section
//! HEADERS now ([`APEX_LIVE_SETTLEMENT_SECTIONS`]) rather than one literal
//! marker, and stripping still panics when a named section is not there
//! live -- a config that quietly loses its settlement must break this
//! module, never coast through it.
//!
//! The verbatim case also drives one claimless request at each file's own
//! terminating route and asserts it is answered with the x402 greeting
//! (#552) naming the committed `price`, rather than served for nothing.
//! Both files priced that route at `0` while the greeting had already
//! landed, so a deployed box was still an open free gateway (issue #557);
//! because the price is read off the committed text like everything else
//! here, this fails again if either file ever silently returns to zero.
//!
//! **Template/section** (`*_devnet_settlement_*_boots_against_a_deployed_contract`)
//! points each file's EVM settlement shape -- the store file's commented
//! `BEGIN`/`END` template, uncommented; the apex file's live
//! `[settlement.evm]`, as committed -- at a freshly deployed contract on a
//! disposable local `anvil`, and boots that. Documented config shapes rot;
//! this keeps them demonstrably working and keeps `runtime::build`'s
//! settlement construction path covered end to end by the real binary. It
//! is skipped when no `anvil` is on `PATH`.
//!
//! The apex's `[settlement.solana]` leg is deliberately NOT booted. It is
//! stripped alongside the rest for the verbatim case and stripped again
//! for the anvil case, which boots the EVM leg only. There is no local
//! `anvil` equivalent standing by here: the committed leg names public
//! Solana devnet (`https://api.devnet.solana.com`) and a program deployed
//! on that cluster, and `SolanaSettlementBackend::connect` does not merely
//! read -- it fetches the program and mint accounts AND submits a
//! transaction (`ensure_own_ata_exists`), so booting it would make this
//! test suite depend on public-internet reachability, on a third party's
//! rate limits, and on a FUNDED devnet account whose key this sandbox
//! cannot have. A chain-backed Solana case would need a
//! `solana-test-validator` with `packages/solana-program` deployed into
//! it (the shape `connector-settlement-solana`'s own tests use) and a
//! retargeted `program_id`/`token_address`; that is a different, heavier
//! test than this module's "the committed file starts" question, and it is
//! not written here.
//!
//! **Parse** (`the_apex_devnet_config_declares_both_committed_settlement_legs`)
//! is what covers the Solana leg instead: it loads the committed apex file
//! through the real `Config::load` -- substituting only the same paths the
//! boot cases substitute -- and asserts both keyed legs parse into typed
//! `SettlementConfig`s carrying the exact committed values. It reaches no
//! chain at all, so it costs nothing and cannot flake, and it still fails
//! loudly if the keyed shape is malformed, if a leg is dropped, or if a
//! committed address/program id/`decimals` drifts. What it deliberately
//! does NOT prove is that those Solana values are real on that cluster --
//! only the fleet's own deploy can show that.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

use chrono::{Duration as ChronoDuration, Utc};
use connector_config::{Config, SettlementConfig};
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

/// Every LIVE (uncommented) settlement section the apex file commits, in
/// issue #628's keyed per-chain shape as of #645 -- the sections
/// [`without_live_settlement`] strips for the hermetic verbatim boot.
///
/// Named exhaustively rather than matched by a `[settlement` prefix so that
/// the list itself is the claim about what the committed file contains:
/// [`without_sections`] panics on a name that is not there live, and
/// [`without_live_settlement`] panics on a live settlement section that is
/// not named here. Between them, neither losing a leg nor adding one can
/// pass silently -- which is exactly what #645's migration off the flat
/// `[settlement]` did to the string-literal marker this replaced.
const APEX_LIVE_SETTLEMENT_SECTIONS: &[&str] = &[
    "[settlement.evm]",
    "[settlement.evm.key]",
    "[settlement.solana]",
    "[settlement.solana.key]",
];

/// The apex file's Solana leg alone -- stripped by the anvil-backed case,
/// which retargets the EVM leg at a local chain and has no local stand-in
/// for this one. See the module docs for why it is not booted.
const APEX_SOLANA_SETTLEMENT_SECTIONS: &[&str] =
    &["[settlement.solana]", "[settlement.solana.key]"];

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

/// The apex file's two settlement key files, each pointed at a real file
/// this sandbox can supply -- the same substitution the `[signer]` key gets
/// in [`with_sandbox_paths`], and for the same reason: real key material is
/// never committed, and config load refuses a `key_file` that is not there.
///
/// Deliberately NOT the same path as the signer's on the committed box (the
/// settlement account is the funded one), but the same temp file serves
/// both legs here: `runtime::read_settlement_key_bytes` reads one shape for
/// either chain -- 32 raw bytes or 64 hex characters, exactly what
/// `write_raw_key_file` produces -- and hands the EVM leg its hex-encoded
/// secp256k1 form while the Solana leg takes the raw 32 bytes as an ed25519
/// seed (issue #630). The committed Solana file is documented as "a 32-byte
/// ed25519 seed as 64 hex chars, same shape as ./settlement-rust.key" for
/// precisely that reason.
fn with_sandbox_settlement_keys(raw: &str, key_path: &std::path::Path) -> String {
    let replaced = replace_expecting_a_match(
        raw,
        "key_file = \"/app/data/settlement.key\"",
        &format!("key_file = \"{}\"", key_path.display()),
    );
    replace_expecting_a_match(
        &replaced,
        "key_file = \"/app/data/settlement-solana.key\"",
        &format!("key_file = \"{}\"", key_path.display()),
    )
}

/// Uncomment the `[settlement]` block a committed file carries between its
/// `BEGIN`/`END` template markers, so the block an operator is told to fill
/// in is the block this test actually boots. A file with no such block is a
/// test failure: either the template was deleted (and this case has nothing
/// left to prove) or a real `[settlement]` section was committed (and the
/// verbatim case is the one that covers it).
/// Remove the named live (uncommented) TOML sections: each header line
/// through the line before the next header at column 0, or the end of the
/// file. Comment lines that happen to precede a removed header are left
/// where they are -- they are prose, and prose parses.
///
/// A named section that is not there live is a test failure, the same
/// fail-loud property [`replace_expecting_a_match`] gives the substitutions
/// above. Matching on the header rather than on a literal slice of file
/// text is what makes this survive the settlement block moving, being
/// reordered, or acquiring new keys, while still refusing to strip a
/// section that has been renamed out from under it.
fn without_sections(raw: &str, headers: &[&str]) -> String {
    let mut out = String::new();
    let mut removed: Vec<&str> = Vec::new();
    let mut removing = false;
    for line in raw.lines() {
        let header = line.trim_end();
        if header.starts_with('[') {
            removing = headers.contains(&header);
            if removing {
                removed.push(header);
            }
        }
        if !removing {
            out.push_str(line);
            out.push('\n');
        }
    }
    for header in headers {
        assert!(
            removed.contains(header),
            "expected a live (uncommented) `{header}` section to strip in the \
             committed config text -- if that section was renamed or removed, \
             update this test rather than letting the strip silently do nothing"
        );
    }
    out
}

/// Strip ALL of the apex file's live settlement sections
/// ([`APEX_LIVE_SETTLEMENT_SECTIONS`]) for the verbatim boot -- see the
/// module docs: a committed live section is a startup-blocking chain
/// dependency by design (ADR 0009), and the sections themselves are proven
/// by the anvil-backed and parse cases below.
///
/// Panics when a named section is not there live, and again when a live
/// settlement section survives that this module has not been taught about
/// -- so neither losing settlement nor adding a chain leg can weaken the
/// verbatim case unnoticed.
fn without_live_settlement(raw: &str) -> String {
    let stripped = without_sections(raw, APEX_LIVE_SETTLEMENT_SECTIONS);
    let survivor = stripped
        .lines()
        .map(str::trim_end)
        .find(|line| line.starts_with("[settlement"));
    assert!(
        survivor.is_none(),
        "the committed config has a live settlement section this test does \
         not know about ({}) -- every leg must be stripped for the hermetic \
         verbatim boot and covered by a case below; add it to \
         `APEX_LIVE_SETTLEMENT_SECTIONS`",
        survivor.unwrap_or_default()
    );
    stripped
}

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
    committed_contract_address: &str,
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
        &format!("contract_address = \"{committed_contract_address}\""),
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
    assert!(APEX_CONFIG.contains("g.toon.ario"));

    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    // No peer_wire_addr in this file (the apex serves no peer wire since
    // #600 terminated the store leg here) -- only the client edge is
    // expected to log a listen line. The live [settlement] tail is
    // stripped for hermeticity (module docs); the anvil-backed case below
    // boots it.
    let connector = boot(
        &with_sandbox_paths(
            &without_live_settlement(APEX_CONFIG),
            key_file.path(),
            state_dir.path(),
        ),
        false,
    );

    assert_answered_with_x402_greeting(&connector.client_edge_addr, "g.toon.relay").await;
    // The store leg (#600): `g.toon.ario` -- the destination the TS fleet's
    // kind:10032 announce names as `routes.store`, i.e. what rig actually
    // dials -- and this fleet's own `g.toon.store` alias are BOTH priced,
    // claim-gated terminated routes on this apex. A peer-forwarded route
    // would greet nothing and charge nothing (the free-gateway gap #620
    // tracks), so these greetings are the regression guard that the store
    // leg stays on the paid path.
    assert_answered_with_x402_greeting(&connector.client_edge_addr, "g.toon.ario").await;
    assert_answered_with_x402_greeting(&connector.client_edge_addr, "g.toon.store").await;
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

/// The registry the apex file's LIVE `[settlement.evm]` section names --
/// the deployed Base Sepolia `TokenNetworkRegistry` (#576, #577). The anvil
/// case replaces exactly this committed value, so it doubles as the guard
/// that the committed section keeps naming it.
const APEX_LIVE_REGISTRY: &str = "0xcC9079adE929b168B54145f6d25262b64FAB9D5b";

#[tokio::test]
async fn the_apex_devnet_settlement_section_boots_against_a_deployed_contract() {
    if !require_anvil() {
        return;
    }
    let (anvil, contract_address, token) = deploy_settlement_on_anvil().await;

    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    // The apex EVM section is LIVE as committed -- no template to
    // uncomment. Its [settlement.evm.key] names its own file
    // (/app/data/settlement.key, distinct from the signer's -- the live box
    // mounts the funded settlement account there), so that path is
    // substituted like the signer key's is.
    //
    // The Solana leg is stripped: this case has a local `anvil` to retarget
    // the EVM leg at and no local stand-in for a Solana cluster, and
    // booting the committed leg as-is would reach public devnet and spend
    // from an account this sandbox has no key for. The parse case below is
    // what covers it. See the module docs.
    let text = without_sections(APEX_CONFIG, APEX_SOLANA_SETTLEMENT_SECTIONS);
    let text = with_anvil_settlement(
        &text,
        &anvil.rpc_url,
        APEX_LIVE_REGISTRY,
        contract_address,
        token,
    );
    let text = replace_expecting_a_match(
        &text,
        "key_file = \"/app/data/settlement.key\"",
        &format!("key_file = \"{}\"", key_file.path().display()),
    );
    let text = with_sandbox_paths(&text, key_file.path(), state_dir.path());

    drop(boot(&text, false));
}

/// The apex file's Solana leg (`https://api.devnet.solana.com`) and the
/// deployed `payment-channel` program it settles through, wired in #633 --
/// asserted as literals here, exactly like [`APEX_LIVE_REGISTRY`] and
/// [`EXPECTED_PRICE`], so that reading the expected values back out of the
/// file under test cannot make this pass on a file that drifted.
const APEX_SOLANA_RPC_URL: &str = "https://api.devnet.solana.com";
const APEX_SOLANA_PROGRAM_ID: &str = "2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip";
const APEX_SOLANA_USDC_MINT: &str = "xyc5J8MgKFiEN13PnfftdXxUzYH34FEvw1LCrFwN7in";

/// The settlement asset's scale on every chain this fleet settles on: ADR
/// 0010's "6 decimals everywhere" (docs/usdc-cross-chain-settlement.md).
/// Both legs must agree with it or `runtime::build` refuses to start
/// against the real token (issues #564, #630) -- a mismatch committed here
/// would be a box that cannot boot.
const EXPECTED_SETTLEMENT_DECIMALS: u8 = 6;

/// Both of the apex file's keyed settlement legs parse, as committed, into
/// the typed per-chain tables issue #628 introduced -- with no chain
/// reached at all.
///
/// This is what covers `[settlement.solana]`, which neither boot case
/// starts (module docs: booting it means public devnet plus a funded
/// account). It is a weaker proof than a boot -- it says the committed
/// shape and values are what the connector expects, not that they exist on
/// that cluster -- but it is the proof available without a network
/// dependency, and it fails on exactly the drift that broke this module
/// when #645 migrated the flat `[settlement]` to the keyed shape.
#[test]
fn the_apex_devnet_config_declares_both_committed_settlement_legs() {
    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let text = with_sandbox_paths(APEX_CONFIG, key_file.path(), state_dir.path());
    let text = with_sandbox_settlement_keys(&text, key_file.path());
    let config_file = write_config(&text);

    let config = Config::load(config_file.path()).expect("the committed apex config must parse");

    let settlements = config.settlements();
    assert_eq!(
        settlements.len(),
        2,
        "the committed apex config must configure exactly the two settlement \
         legs this fleet runs (EVM + Solana), found: {:?}",
        settlements
            .iter()
            .map(|s| s.chain().name())
            .collect::<Vec<_>>()
    );

    let evm = settlements
        .iter()
        .find_map(|settlement| match settlement {
            SettlementConfig::Evm(evm) => Some(evm),
            SettlementConfig::Solana(_) => None,
        })
        .expect("a live [settlement.evm] leg");
    assert_eq!(
        format!("0x{}", hex_lower(evm.contract_address().as_slice())).to_lowercase(),
        APEX_LIVE_REGISTRY.to_lowercase(),
        "the EVM leg must keep naming the deployed TokenNetworkRegistry"
    );
    assert_eq!(evm.decimals(), EXPECTED_SETTLEMENT_DECIMALS);

    let solana = settlements
        .iter()
        .find_map(|settlement| match settlement {
            SettlementConfig::Solana(solana) => Some(solana),
            SettlementConfig::Evm(_) => None,
        })
        .expect("a live [settlement.solana] leg");
    assert_eq!(solana.rpc_url(), APEX_SOLANA_RPC_URL);
    assert_eq!(
        solana.program_id(),
        APEX_SOLANA_PROGRAM_ID,
        "the Solana leg must keep naming the deployed payment-channel program"
    );
    assert_eq!(solana.token_address(), APEX_SOLANA_USDC_MINT);
    assert_eq!(solana.decimals(), EXPECTED_SETTLEMENT_DECIMALS);
}

/// Lowercase hex, for comparing a parsed 20-byte EVM address back against
/// the committed literal.
fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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
    let text = with_anvil_settlement(
        &text,
        &anvil.rpc_url,
        "0x0000000000000000000000000000000000000000",
        contract_address,
        token,
    );
    let text = with_sandbox_paths(&text, key_file.path(), state_dir.path());

    drop(boot(&text, true));
}
