//! Proves the devnet overlay's own committed `connector.toml` files
//! (issue #490, ADR 0013's parallel fleet) load and serve by the actual
//! compiled binary -- the first acceptance criterion, and per the issue's
//! own scope boundary, the only one this sandbox (no Docker, no
//! infrastructure credentials) can verify. Reachability of the peer or the
//! apps behind any of these routes is explicitly NOT proven here.
//!
//! The fleet is THREE files as of issue #817: the apex
//! (`infra/linode-node/`), the store (`infra/linode-store/`) and the relay
//! (`infra/linode-relay/`, added by #816 -- client-edge-only until #820 gave
//! it its own peering to the apex, mirroring the apex<->store shape). There
//! are two cases per file (three for the apex), and they prove different
//! things.
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
//! `[settlement]` section went LIVE against Base Sepolia (#577), and the
//! store file followed it live when the store box grew a Rust connector of
//! its own (the relay file was committed live from day one, #816): a
//! committed live section means the node cannot start without
//! reaching that chain -- the fail-closed behaviour ADR 0009 asks for, and
//! exactly the network dependency a test must not have. So ALL THREE
//! verbatim cases now boot with their live settlement sections STRIPPED
//! ([`without_live_settlement`]), and those sections are proven by the
//! cases described below. This was module-doc'd here as "a decision to
//! revisit deliberately" before #577 shipped; this is that decision.
//!
//! The store file's settlement stopped being a commented template when that
//! node became a counterparty rather than a terminus: it accepts client-edge
//! claims of its own, on whichever chain the buyer chose, so an EVM-only
//! node would refuse every Solana-paid write. Its section is asserted to
//! name the SAME registry, program and mint the apex names, because a
//! buyer's channel lives on one deployment and a node pointed elsewhere
//! cannot resolve it.
//!
//! Since #645 the apex file carries issue #628's KEYED per-chain shape --
//! `[settlement.evm]` + `[settlement.evm.key]` and `[settlement.solana]` +
//! `[settlement.solana.key]` -- in place of the single flat `[settlement]`
//! (`chain = "evm"`) table. That migration is precisely the drift this
//! module exists to catch, and it caught it: [`without_live_settlement`]
//! looked for a literal `"\n[settlement]\n"` that no longer existed, and
//! the anvil case knew nothing of the second key file, so both apex cases
//! failed against the committed config. They are keyed off the section
//! HEADERS now ([`LIVE_SETTLEMENT_SECTIONS`]) rather than one literal
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
//! here, this fails again if any file ever silently returns to zero.
//!
//! **Section** (`*_devnet_settlement_section_boots_against_a_deployed_contract`)
//! points each file's live `[settlement.evm]`, as committed, at a freshly
//! deployed contract on a disposable local `anvil`, and boots that. All
//! three are on issue #628's keyed shape, and all three cases assert it
//! rather than trusting a reader's eye, because the legacy flat table they
//! left behind still parses and so a slide back would otherwise be silent.
//! Committed config shapes rot; this keeps them demonstrably working and keeps
//! `runtime::build`'s settlement construction path covered end to end by the
//! real binary. It is skipped when no `anvil` is on `PATH`.
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
use connector_config::{Config, SettlementConfig, TransportPolicy};
use connector_domain::{derive_condition, EnvelopeRequest, Prepare};
use connector_settlement_evm::test_support::{require_anvil, Anvil, DEPLOYER_PRIVATE_KEY};
use connector_settlement_evm::EvmSettlementBackend;

mod support;
use support::{parse_json_log_addr, write_config, write_raw_key_file};

const APEX_CONFIG: &str = include_str!("../../../infra/linode-node/connector-rust.toml");
const STORE_CONFIG: &str = include_str!("../../../infra/linode-store/connector-rust.toml");
const RELAY_CONFIG: &str = include_str!("../../../infra/linode-relay/connector-rust.toml");

/// The apex's announcer sidecar overlay (issue #833) -- committed separately
/// from `APEX_CONFIG` because it configures a different process
/// (`packages/announcer`, not the connector binary this module otherwise
/// boots), but read here for the one property test that ties the two
/// together: [`the_apex_announcer_never_advertises_a_prefix_it_forwards`].
const ANNOUNCER_OVERLAY: &str =
    include_str!("../../../infra/linode-node/docker-compose.node.announcer.yml");

/// The apex's own Rust overlay (issue #490), read here for
/// [`every_fleet_overlay_pins_the_connector_repos_pin_of_record`] -- the
/// apex has no `announce` overlay of its own (it still announces through
/// `packages/announcer`'s sidecar as of issue #848), so this is its only
/// `image:` pin.
const APEX_RUST_OVERLAY: &str =
    include_str!("../../../infra/linode-node/docker-compose.node.rust.yml");

/// The store box's two overlays, read here for one property they must share
/// and which nothing else in this suite could see: they bind-mount the SAME
/// `connector-rust.toml`, so they must pin the same image tag. See
/// [`store_overlays_sharing_one_config_pin_one_image`].
const STORE_RUST_OVERLAY: &str =
    include_str!("../../../infra/linode-store/docker-compose.store.rust.yml");
const STORE_ANNOUNCE_OVERLAY: &str =
    include_str!("../../../infra/linode-store/docker-compose.store.announce.yml");

/// The relay box's two overlays (issue #843, repo half of #815), read here
/// for the same property as the store's pair above: they bind-mount the
/// SAME `connector-rust.toml`, so they must pin the same image tag. See
/// [`relay_overlays_sharing_one_config_pin_one_image`].
const RELAY_RUST_OVERLAY: &str =
    include_str!("../../../infra/linode-relay/docker-compose.relay.rust.yml");
const RELAY_ANNOUNCE_OVERLAY: &str =
    include_str!("../../../infra/linode-relay/docker-compose.relay.announce.yml");

/// This test binary's own base port for [`Anvil::spawn`] -- distinct from
/// other test binaries' bases (`connector-settlement-evm`'s own tests use
/// 18_600; `connector-cli`'s use 18_700/18_800) so that binaries running
/// concurrently under `cargo test --workspace` don't contend for the same
/// port range.
const ANVIL_BASE_PORT: u16 = 18_500;

/// Every LIVE (uncommented) settlement section any of the fleet's three
/// files (apex, store, relay -- issue #817) commits, in issue #628's keyed
/// per-chain shape as of #645 -- the sections [`without_live_settlement`]
/// strips for the hermetic verbatim boot. All three name the exact same
/// four headers, so one list covers all of them; a file that ever needs a
/// different set is a reason to split this constant, not to widen it
/// silently.
///
/// Named exhaustively rather than matched by a `[settlement` prefix so that
/// the list itself is the claim about what the committed file contains:
/// [`without_sections`] panics on a name that is not there live, and
/// [`without_live_settlement`] panics on a live settlement section that is
/// not named here. Between them, neither losing a leg nor adding one can
/// pass silently -- which is exactly what #645's migration off the flat
/// `[settlement]` did to the string-literal marker this replaced.
const LIVE_SETTLEMENT_SECTIONS: &[&str] = &[
    "[settlement.evm]",
    "[settlement.evm.key]",
    "[settlement.solana]",
    "[settlement.solana.key]",
];

/// Any fleet file's Solana leg alone -- stripped by the anvil-backed cases,
/// which retarget the EVM leg at a local chain and have no local stand-in
/// for this one. See the module docs for why it is not booted.
const SOLANA_SETTLEMENT_SECTIONS: &[&str] = &["[settlement.solana]", "[settlement.solana.key]"];

/// The `price` the committed files put on their **store** routes, and so
/// the amount the x402 greeting must quote for them. Deliberately a literal
/// rather than something parsed back out of the file under test: a test
/// that read the expected value from the thing it is testing would keep
/// passing if that value went back to `0`, which is exactly the regression
/// issue #557 exists to prevent. Parity with the TypeScript fleet's
/// `price: '1000'` on the same box (`infra/linode-node/connector.yaml`).
const EXPECTED_STORE_PRICE: u64 = 1000;

/// The `price` the apex file puts on `g.toon.relay`, which is **not** the
/// store price and is deliberately not folded into one constant. Shared
/// with the relay box's own file (`infra/linode-relay/connector-rust.toml`,
/// issue #816/#817): its terminating route names the same literal, since
/// it is deliberately the same per-frame price quoted for the same prefix,
/// today just answered on a different box.
///
/// The apex box served `1` from 2026-08-03; the repo said `1000` while the
/// comment above the value asserted parity with the TypeScript route on the
/// same box. Owner decision 2026-08-04: **`1` is correct** -- 1 micro-USDC
/// is the per-frame price the buzz huddles workload needs (49 fps over BTP,
/// toon-meta#262), and a general-write price is the wrong frame for this
/// route. The repo is moved to the box rather than the box to the repo.
///
/// Two separate literals, not one, because the two prices now genuinely
/// differ and a single constant would have to be loosened to a range --
/// which is how #557's guard would rot into asserting nothing. Each is
/// still a literal for exactly the reason above.
///
/// **This is a live 1000x gap against the TypeScript fleet's own
/// `g.toon.relay` (`price: '1000'`), which fronts the same `relay:3100`.**
/// It is not an oversight and it does not need reconciling: TypeScript is
/// being retired, and on the day the Rust connector becomes the default
/// edge this value simply becomes the devnet's relay price.
const EXPECTED_RELAY_PRICE: u64 = 1;

/// The `price` the apex charges its own client for `g.toon.ario`, which it
/// FORWARDS across the peering rather than terminating.
///
/// A third literal rather than an expression over the other two, for the
/// same reason they are literals: a value derived from the config would keep
/// passing if the config drifted. What ties it to the others is the separate
/// arithmetic assertion in
/// [`the_forwarded_store_leg_delivers_exactly_the_far_ends_price`] below.
const EXPECTED_APEX_FORWARD_PRICE: u64 = 1002;

/// What the apex retains for carriage on that forward (ADR 0010/0028),
/// matching the TypeScript fleet's own inter-node fee of 2.
const EXPECTED_APEX_FORWARD_FEE: u64 = 2;

/// The `price` the apex charges its own client for `g.toon.relay` as of
/// issue #820, which it now FORWARDS across the apex<->relay peering rather
/// than terminating. Numerically equal to [`EXPECTED_RELAY_PRICE`], but a
/// separate literal for the same reason [`EXPECTED_APEX_FORWARD_PRICE`] is
/// separate from [`EXPECTED_STORE_PRICE`]: the two prices are asserted
/// independently and tied together only by the explicit arithmetic check in
/// [`the_forwarded_relay_leg_delivers_exactly_the_far_ends_price`], not by
/// sharing one constant.
const EXPECTED_RELAY_FORWARD_PRICE: u64 = 1;

/// What the apex retains for carriage on the `g.toon.relay` forward (owner
/// decision 2026-08-06, docs/devnet-pricing.md's "The g.toon.relay forward:
/// price/fee split"): zero, deliberately, unlike the store leg's fee of 2 --
/// `g.toon.relay` carries buzz huddles at 49 fps over BTP, so any non-zero
/// fee here would force `price` above the relay's own terminating price,
/// doubling the per-frame client cost for a workload billed 49 times a
/// second.
const EXPECTED_RELAY_FORWARD_FEE: u64 = 0;

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

/// A temp file holding a peering secret, for the `secret_file` the committed
/// configs name (issue #750). The bytes are arbitrary -- nothing in a boot
/// test compares them against a counterparty -- but the file must EXIST,
/// because a `secret_file` that cannot be read is a refuse-to-start.
fn write_peer_secret() -> tempfile::NamedTempFile {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new().expect("temp peer secret");
    file.write_all(b"sandbox-peering-secret\n")
        .expect("write peer secret");
    file.flush().expect("flush peer secret");
    file
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
/// load-bearing -- deleting the line from any of the fleet's files fails
/// this test rather than silently testing a node with no durable state.
///
/// `peer_secret` is `Some` for a file that carries a peering and `None` for
/// one that does not -- see the `match` at the end.
fn with_sandbox_paths(
    raw: &str,
    key_path: &std::path::Path,
    state_dir: &std::path::Path,
    peer_secret: Option<&std::path::Path>,
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
    // The peering's shared secret (issue #750), same substitution and same
    // reason as the key files: the committed configs name a path on the box,
    // never the bytes, and config load refuses a `secret_file` that is not
    // there. Every `secret_file = "..."` line is replaced with the SAME temp
    // path -- the apex file carries two as of issue #820 (`apex-store` and
    // `apex-relay`), and a boot test does not compare bytes against a
    // counterparty, so one shared sandbox secret for however many peerings a
    // file declares is enough.
    //
    // `None` for a client-edge-only file with no `[[peers]]` table of its
    // own at all -- the store and relay boxes both had this shape once
    // (issues #816/#817), neither does any more as of #820. A caller that
    // passes `None` against a file which DOES carry a `secret_file` gets a
    // clear panic rather than `Config::load` refusing later with a confusing
    // "file not found".
    match peer_secret {
        Some(peer_secret) => repoint_every_secret_file(&replaced, peer_secret),
        None => {
            assert!(
                !replaced.contains("secret_file ="),
                "this config carries a `secret_file` but was booted with no \
                 peer secret -- pass `Some(..)` to `with_sandbox_paths` for it"
            );
            replaced
        }
    }
}

/// Point every `secret_file = "/app/data/…"` line in `raw` at `peer_secret`,
/// keeping the rest of each line (an inline table's trailing ` }`) intact.
///
/// A line rewrite rather than a [`replace_expecting_a_match`] call per
/// peering: the apex file carries two `secret_file` lines as of issue #820
/// (`apex-store` and `apex-relay`) and would grow a third the day a third
/// peering lands, so the substitution follows the file instead of having to
/// be re-taught each committed path. Finding no line at all is a failure,
/// for the same reason `replace_expecting_a_match` exists.
fn repoint_every_secret_file(raw: &str, peer_secret: &std::path::Path) -> String {
    const NEEDLE: &str = "secret_file = \"/app/data/";

    let mut out = String::with_capacity(raw.len());
    let mut replaced_any = false;
    for line in raw.lines() {
        match line.find(NEEDLE) {
            Some(start) => {
                let after_needle = &line[start + NEEDLE.len()..];
                let close_quote = after_needle
                    .find('"')
                    .unwrap_or_else(|| panic!("`{NEEDLE}` line has no closing quote: {line:?}"));
                out.push_str(&line[..start]);
                out.push_str(&format!("secret_file = \"{}\"", peer_secret.display()));
                out.push_str(&after_needle[close_quote + 1..]);
                replaced_any = true;
            }
            None => out.push_str(line),
        }
        out.push('\n');
    }

    assert!(
        replaced_any,
        "expected at least one `secret_file` line in the committed config \
         text -- if every peering was removed, pass `None` instead of \
         `Some(..)` here"
    );
    out
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

/// Strip ALL of a fleet file's live settlement sections
/// ([`LIVE_SETTLEMENT_SECTIONS`]) for the verbatim boot -- see the module
/// docs: a committed live section is a startup-blocking chain dependency by
/// design (ADR 0009), and the sections themselves are proven by the
/// anvil-backed and parse cases below. Shared by all three fleet files
/// (apex, store, relay), which all commit the same four headers.
///
/// Panics when a named section is not there live, and again when a live
/// settlement section survives that this module has not been taught about
/// -- so neither losing settlement nor adding a chain leg can weaken the
/// verbatim case unnoticed.
fn without_live_settlement(raw: &str) -> String {
    let stripped = without_sections(raw, LIVE_SETTLEMENT_SECTIONS);
    let survivor = stripped
        .lines()
        .map(str::trim_end)
        .find(|line| line.starts_with("[settlement"));
    assert!(
        survivor.is_none(),
        "the committed config has a live settlement section this test does \
         not know about ({}) -- every leg must be stripped for the hermetic \
         verbatim boot and covered by a case below; add it to \
         `LIVE_SETTLEMENT_SECTIONS`",
        survivor.unwrap_or_default()
    );
    stripped
}

/// Point an uncommented `[settlement.evm]` block at a real, disposable,
/// freshly deployed local chain. `decimals` and the key location stay the
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
        &format!("token_address = \"{EXPECTED_SETTLEMENT_TOKEN_ADDRESS}\""),
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

/// Reads stdout lines until `"connector listening"` is seen, returning the
/// client edge's actual bound address; or the process exits first -- which
/// fails with the exit status and whatever the process printed on stderr,
/// rather than hanging or reporting only that a pipe closed.
///
/// There is one listen line to wait for since ADR 0027 / issue #679 deleted
/// the raw-TCP peer wire and its separate listener.
fn wait_for_listen_line(child: &mut Child) -> String {
    let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
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
            return parse_json_log_addr(&line);
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

fn boot(config_text: &str) -> BootedConnector {
    let config_file = write_config(config_text);
    let mut child = spawn(config_file.path());
    let client_edge_addr = wait_for_listen_line(&mut child);
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
/// greeting (HTTP 402, terms naming `expected_price`) instead of being
/// forwarded to the app -- the free-gateway failure mode this issue closes.
///
/// The price is a parameter rather than one module constant because the
/// apex prices `g.toon.relay` and its store legs differently (see
/// [`EXPECTED_RELAY_PRICE`]). Every caller passes a literal, so the guard
/// keeps the property #557 needs: the expectation is never read back out of
/// the file under test.
async fn assert_answered_with_x402_greeting(
    client_edge_addr: &str,
    destination: &str,
    expected_price: u64,
) {
    let terms = x402_terms(client_edge_addr, destination).await;
    assert_eq!(
        terms["accepts"][0]["amount"],
        expected_price.to_string(),
        "greeted price for {destination} must match the route's committed `price`"
    );
    assert_ne!(
        expected_price, 0,
        "a zero price is the free-gateway regression issue #557 exists to catch"
    );
}

/// The x402 terms JSON a claimless request to `destination` is answered
/// with -- shared by [`assert_answered_with_x402_greeting`] (an ordinary
/// unpaid-request greeting) and the transport-policy test below (issue
/// #701), which reuses the same 402 shape for a different reason.
async fn x402_terms(client_edge_addr: &str, destination: &str) -> serde_json::Value {
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
    response.json().await.expect("x402 JSON terms")
}

#[tokio::test]
async fn the_apex_relay_side_devnet_config_loads_and_serves_verbatim() {
    assert!(APEX_CONFIG.contains("g.toon.relay"));
    assert!(APEX_CONFIG.contains("g.toon.ario"));
    // `g.toon.store` was retired on 2026-08-05 (owner decision): one name
    // for one app. This asserts its ABSENCE, so re-adding the alias has to
    // be a deliberate edit here too rather than drifting back in.
    assert!(!APEX_CONFIG.contains("prefix = \"g.toon.store\""));

    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let peer_secret = write_peer_secret();
    // The live [settlement] tail is stripped for hermeticity (module
    // docs); the anvil-backed case below boots it.
    let connector = boot(&with_sandbox_paths(
        &without_live_settlement(APEX_CONFIG),
        key_file.path(),
        state_dir.path(),
        Some(peer_secret.path()),
    ));

    // Greeted at [`EXPECTED_RELAY_FORWARD_PRICE`], not [`EXPECTED_RELAY_PRICE`]
    // (the relay box's own terminate price, asserted by the relay's own
    // verbatim case below): since issue #820 this is a `peer_id` forward
    // across the apex<->relay peering, not a local `handler_url` route, and
    // the two prices are asserted independently even though they currently
    // share the same literal (owner decision, docs/devnet-pricing.md).
    assert_answered_with_x402_greeting(
        &connector.client_edge_addr,
        "g.toon.relay",
        EXPECTED_RELAY_FORWARD_PRICE,
    )
    .await;
    // The store leg (#600): `g.toon.ario` is the destination a shipped
    // client actually dials (buzz pins it in compiled code), and since
    // 2026-08-04 it is FORWARDED across the apex<->store peering rather than
    // terminated here.
    //
    // Greeted at [`EXPECTED_APEX_FORWARD_PRICE`], not the store's own price:
    // ADR 0028 gives a forwarded route a client-edge `price` and a `fee` the
    // hop retains, so what a client pays here is strictly more than what the
    // far end charges. That a `peer_id` route is greeted AT ALL is the #620
    // property -- before it, a peer route greeted nothing and charged
    // nothing, which is a free-write path on `g.toon`.
    assert_answered_with_x402_greeting(
        &connector.client_edge_addr,
        "g.toon.ario",
        EXPECTED_APEX_FORWARD_PRICE,
    )
    .await;
}

#[tokio::test]
async fn the_store_side_devnet_config_loads_and_serves_verbatim() {
    // The one prefix this box terminates, and the reason the config exists:
    // a store box that did not answer `g.toon.ario` could not take over from
    // the TypeScript node it replaced.
    assert!(STORE_CONFIG.contains("g.toon.ario"));
    // `g.toon.relay.ario`, the relay-hop spelling, was retired by issue #820
    // alongside `g.toon.store` -- it was never actually reachable (see
    // docs/devnet-pricing.md's "Retired names"). Asserting its ABSENCE, same
    // as the `g.toon.store` check below, so re-adding it has to be a
    // deliberate edit here too rather than drifting back in.
    assert!(!STORE_CONFIG.contains("prefix = \"g.toon.relay.ario\""));

    // No peer wire: this node accepts no inbound peer connection and dials
    // no peer, so only the client edge comes up. ADR 0003's raw-TCP wire
    // cannot carry the public inter-node link this fleet needs (#623), so
    // the file configures neither -- see its header. (A peer-forwarded
    // route being unpriced on both sides was the file's other stated
    // reason; ADR 0028 removed it, and #678 wired the carriages, so what
    // remains is a deployment decision rather than a missing mechanism.)
    // When the inter-connector transport decision lands, this is the
    // assertion that changes.
    // Line-anchored, like the `chain = ` check further down: the header is
    // free to *name* `peer_wire_addr` while explaining at length why it is
    // gone, so only an actual uncommented assignment counts.
    assert!(
        !STORE_CONFIG
            .lines()
            .any(|line| line.starts_with("peer_wire_addr")),
        "the store config must not bind ADR 0003's plaintext peer wire on a \
         box with no private segment -- if a peering is being added, it \
         should arrive with the transport that replaces it"
    );

    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let peer_secret = write_peer_secret();
    let connector = boot(&with_sandbox_paths(
        &without_live_settlement(STORE_CONFIG),
        key_file.path(),
        state_dir.path(),
        Some(peer_secret.path()),
    ));

    assert_answered_with_x402_greeting(
        &connector.client_edge_addr,
        "g.toon.ario",
        EXPECTED_STORE_PRICE,
    )
    .await;
    // `g.toon.store` was retired here too (owner decision, 2026-08-05).
    assert!(!STORE_CONFIG.contains("prefix = \"g.toon.store\""));
}

/// The relay box's own file (issue #816/#817), modelled on the store's case
/// above: a connector that terminates `g.toon.relay` against the relay app
/// now co-located with it, in place of the apex's former local `handler_url`
/// route to the same app -- and, as of issue #820, also carries the
/// accept-only half of the apex<->relay peering (mirroring the store box's
/// own accept-only shape).
#[tokio::test]
async fn the_relay_side_devnet_config_loads_and_serves_verbatim() {
    assert!(RELAY_CONFIG.contains("g.toon.relay"));

    // Issue #820: this box now peers with the apex. Line-anchored because
    // the file's own header prose is free to *name* both tables while
    // explaining them, so a substring match would trip on prose rather than
    // an actual table.
    assert!(
        RELAY_CONFIG.lines().any(|line| line.trim() == "[[peers]]")
            && RELAY_CONFIG
                .lines()
                .any(|line| line.trim() == "[[peer_channels]]"),
        "the relay box is expected to carry its own [[peers]]/\
         [[peer_channels]] table as of issue #820 -- if that changed, this \
         test's premise (and `with_sandbox_paths`'s peer-secret argument \
         below) needs revisiting, not silently dropping the peer secret"
    );

    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let peer_secret = write_peer_secret();
    let connector = boot(&with_sandbox_paths(
        &without_live_settlement(RELAY_CONFIG),
        key_file.path(),
        state_dir.path(),
        Some(peer_secret.path()),
    ));

    assert_answered_with_x402_greeting(
        &connector.client_edge_addr,
        "g.toon.relay",
        EXPECTED_RELAY_PRICE,
    )
    .await;
}

/// ADR 0028's arithmetic, across the two committed files: what the apex
/// forwards must be EXACTLY what the far end charges.
///
/// This replaces an equality test (`both configs price the prefix the same`)
/// whose premise the peering retired. While the apex terminated the store leg
/// at the store box's public nginx there genuinely were two doors into one
/// handler, and an unequal pair was an arbitrage the cheaper door would win.
/// Now there is one path: a client pays the apex `price`, the apex keeps
/// `fee`, and `price - fee` arrives at a route the store box prices itself.
///
/// The relation is a stop-ship, not a tidiness check. Under-forwarding was
/// survivable only while issue #752 was open -- a terminating connector did
/// not charge its `price` for a peer-wire arrival, so the store box never
/// checked. #754 landed that charge, so `price - fee` short of the far end's
/// price is now an F03 on every forwarded write.
#[test]
fn the_forwarded_store_leg_delivers_exactly_the_far_ends_price() {
    let forwarded = EXPECTED_APEX_FORWARD_PRICE - EXPECTED_APEX_FORWARD_FEE;
    assert_eq!(
        forwarded, EXPECTED_STORE_PRICE,
        "the apex charges {EXPECTED_APEX_FORWARD_PRICE} and keeps \
         {EXPECTED_APEX_FORWARD_FEE}, so {forwarded} reaches the store box -- \
         which prices the same prefix at {EXPECTED_STORE_PRICE}. Since #754 a \
         short-forward is an F03, not a silent subsidy"
    );

    // And the literals above must still be what the files say.
    assert_eq!(
        route_price(APEX_CONFIG, "g.toon.ario"),
        EXPECTED_APEX_FORWARD_PRICE
    );
    assert_eq!(
        route_price(STORE_CONFIG, "g.toon.ario"),
        EXPECTED_STORE_PRICE
    );
}

/// The relay sibling of the test above (issue #820): what the apex forwards
/// across the apex<->relay peering must be EXACTLY what the relay box's own
/// terminating route charges. Owner decision 2026-08-06 makes this a 1/0
/// split rather than the store leg's 1002/2 -- see
/// docs/devnet-pricing.md's "The g.toon.relay forward: price/fee split" for
/// the full argument (a non-zero fee would force the apex's `price` above
/// the relay's own `1`, doubling the per-frame cost of a 49fps workload) --
/// but the property itself is the same #754 stop-ship: a short forward is an
/// F03 on every write, not a silent subsidy.
#[test]
fn the_forwarded_relay_leg_delivers_exactly_the_far_ends_price() {
    let forwarded = EXPECTED_RELAY_FORWARD_PRICE - EXPECTED_RELAY_FORWARD_FEE;
    assert_eq!(
        forwarded, EXPECTED_RELAY_PRICE,
        "the apex charges {EXPECTED_RELAY_FORWARD_PRICE} and keeps \
         {EXPECTED_RELAY_FORWARD_FEE}, so {forwarded} reaches the relay box -- \
         which prices the same prefix at {EXPECTED_RELAY_PRICE}. Since #754 a \
         short-forward is an F03, not a silent subsidy"
    );

    // And the literals above must still be what the files say.
    assert_eq!(
        route_price(APEX_CONFIG, "g.toon.relay"),
        EXPECTED_RELAY_FORWARD_PRICE
    );
    assert_eq!(
        route_price(RELAY_CONFIG, "g.toon.relay"),
        EXPECTED_RELAY_PRICE
    );
}

/// The `price` of the `[[routes]]` entry whose `prefix` matches, read from
/// the committed text rather than from a loaded `Config` so this works
/// without the settlement legs the loader would insist on reaching.
fn route_price(raw: &str, prefix: &str) -> u64 {
    let mut in_route = false;
    for line in raw.lines().map(str::trim) {
        if line == "[[routes]]" {
            in_route = false;
            continue;
        }
        if line == format!("prefix = \"{prefix}\"") {
            in_route = true;
            continue;
        }
        if in_route {
            if let Some(value) = line.strip_prefix("price = ") {
                return value.parse().expect("a numeric price");
            }
        }
    }
    panic!("no priced `{prefix}` route in the committed config text");
}

/// The value `key` is set to in the apex's announcer sidecar overlay, read
/// straight off the committed line -- matching [`route_price`]'s precedent
/// of reading a config-shape assertion off the committed text rather than
/// pulling in a YAML parser for one env var.
fn announcer_env(raw: &str, key: &str) -> String {
    let needle = format!("{key}:");
    raw.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix(&needle))
        .unwrap_or_else(|| panic!("the announcer overlay must set {key}"))
        .trim()
        .to_string()
}

/// The `ANNOUNCER_ILP_ADDRESSES` CSV value the apex's announcer sidecar
/// overlay commits, split into its entries.
///
/// Each entry is trimmed individually, not just the value as a whole: YAML
/// accepts `g.toon, g.toon.relay` for the same list, and an untrimmed
/// ` g.toon.relay` would compare unequal to the route prefix it names --
/// which would let the property test below pass over exactly the announce
/// it exists to refuse.
fn announcer_ilp_addresses(raw: &str) -> Vec<String> {
    announcer_env(raw, "ANNOUNCER_ILP_ADDRESSES")
        .split(',')
        .map(|address| address.trim().to_string())
        .collect()
}

/// Issue #833's core property: this node must never advertise, under its
/// OWN identity, an address it FORWARDS rather than terminates. A stock
/// client seals a gift wrap to whichever `edgeIdentity` published the
/// announce it read -- ADR 0018 requires that be the TERMINATING
/// connector's key, but nothing on the wire enforces a publisher only
/// advertising what it terminates. An announce claiming a forwarded prefix
/// under the forwarder's own key is exactly the defect that let a client
/// pay `g.toon.ario`, seal to the apex, and be refused
/// `F01 gift wrap could not be opened` at the store -- after the money was
/// already spent.
///
/// Asserted as a PROPERTY over the apex's own committed `[[routes]]` table
/// (which prefixes it forwards, via `Config::peer_routes()`) against the
/// announcer overlay's committed `ANNOUNCER_ILP_ADDRESSES` (which prefixes
/// it announces), rather than a literal "must not contain g.toon.ario"
/// string: nothing before this test modelled two connectors with distinct
/// identities where one forwards a prefix the other terminates, which is
/// exactly why the defect survived every other gate. The same defect
/// reproduces the moment `g.toon.relay` becomes a forwarded `peer_id` route
/// (issue #820) if this sidecar is still announcing it then, and a property
/// test catches that the day it happens rather than needing to be re-taught
/// the new prefix by hand -- the issue's own "gate #820 on this".
#[test]
fn the_apex_announcer_never_advertises_a_prefix_it_forwards() {
    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let peer_secret = write_peer_secret();
    let text = with_sandbox_paths(
        &without_live_settlement(APEX_CONFIG),
        key_file.path(),
        state_dir.path(),
        Some(peer_secret.path()),
    );
    let config_file = write_config(&text);
    let config = Config::load(config_file.path()).expect("the committed apex config must parse");

    let forwarded: Vec<&str> = config.peer_routes().iter().map(|r| r.prefix()).collect();
    assert!(
        !forwarded.is_empty(),
        "the apex config is expected to forward at least `g.toon.ario` \
         across the apex-store peering -- if that changed, this test's \
         premise needs revisiting, not silently passing over an empty set"
    );

    let announced = announcer_ilp_addresses(ANNOUNCER_OVERLAY);
    for prefix in forwarded {
        assert!(
            !announced.iter().any(|a| a == prefix),
            "the announcer sidecar's ANNOUNCER_ILP_ADDRESSES names `{prefix}`, \
             which the apex config forwards (not terminates) via a peer_id \
             route -- announcing it under the apex's OWN identity is issue \
             #833's exact defect: a client seals its gift wrap to the \
             publisher's key, pays, and the terminating node refuses to open \
             it. Give the terminating node its own publisher instead (see \
             infra/linode-store/connector-rust.toml's [announce] section) \
             and drop the prefix from this list"
        );
    }
}

/// Issue #841 (extended by #843 to cover `ANNOUNCER_ROUTE_PUBLISH` too):
/// `routes.store`/`routes.publish` in the kind:10032 announce are how a
/// client finds where to upload/publish -- each must name a prefix this
/// node actually has a route for (terminated or forwarded), or every client
/// that trusts it gets `F02 no route`. Both hints are DERIVED when their
/// override env var is unset (`deriveRouteHints`,
/// `packages/announcer/src/config.ts`), off whichever `.store`/`.ario` or
/// `.relay` entry is in `ANNOUNCER_ILP_ADDRESSES` -- and derivation falls
/// through to guessing one hint FROM the other when its own suffix is
/// absent from that list. #833 removing `g.toon.ario` silently fired the
/// store guess (`g.toon.relay` -> `g.toon.store`, issue #841); #843 removing
/// `g.toon.relay` would just as silently fire the PUBLISH guess the other
/// way (`g.toon.ario` -> `g.toon.relay`'s spot, i.e. `routes.publish =
/// g.toon.ario`) if the override were left unset. Both are pinned overrides
/// now, and this test covers both rather than just the one #841 caught.
///
/// Asserted as a property over the apex's own committed route table rather
/// than a literal on both sides -- a test that hardcodes the same string
/// twice passes even if both are wrong together, which is exactly the shape
/// #839's test missed this in.
#[test]
fn the_announced_route_hints_name_prefixes_the_apex_actually_routes() {
    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let peer_secret = write_peer_secret();
    let text = with_sandbox_paths(
        &without_live_settlement(APEX_CONFIG),
        key_file.path(),
        state_dir.path(),
        Some(peer_secret.path()),
    );
    let config_file = write_config(&text);
    let config = Config::load(config_file.path()).expect("the committed apex config must parse");

    let routed: Vec<&str> = config
        .routes()
        .iter()
        .map(|r| r.prefix())
        .chain(config.peer_routes().iter().map(|r| r.prefix()))
        .collect();

    for (env_key, announce_field) in [
        ("ANNOUNCER_ROUTE_STORE", "routes.store"),
        ("ANNOUNCER_ROUTE_PUBLISH", "routes.publish"),
    ] {
        let hint = announcer_env(ANNOUNCER_OVERLAY, env_key);
        assert!(
            routed.iter().any(|prefix| *prefix == hint),
            "the announcer overlay's {env_key} names `{hint}`, which is not \
             a prefix the apex's own committed connector-rust.toml routes at \
             all (routed prefixes: {routed:?}) -- a client reading \
             `{announce_field}` off the kind:10032 announce would get \
             F02 no route. See issue #841/#843"
        );
    }
}

/// Issue #833's fix, terminating side: the store box announces
/// `g.toon.ario` under its OWN `[signer]` identity -- the key that answers
/// this node's `/ilp/identity` and opens every gift wrap it terminates
/// (ADR 0018) -- rather than depending on the apex's now-removed stopgap
/// announce (the property test above is what makes removing that stopgap
/// safe to assert here rather than merely hoped for).
#[test]
fn the_store_devnet_config_announces_g_toon_ario_under_its_own_identity() {
    assert!(
        STORE_CONFIG.contains("[announce]"),
        "the store config must carry its own [announce] section -- issue #833"
    );

    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let peer_secret = write_peer_secret();
    let text = with_sandbox_paths(
        STORE_CONFIG,
        key_file.path(),
        state_dir.path(),
        Some(peer_secret.path()),
    );
    let text = with_sandbox_settlement_keys(&text, key_file.path());
    let config_file = write_config(&text);
    let config = Config::load(config_file.path()).expect("the committed store config must parse");

    let announce = config
        .announce()
        .expect("the store config's [announce] section must parse");
    assert_eq!(announce.primary_address(), "g.toon.ario");
    assert_eq!(
        announce.http_endpoint(),
        "https://proxy.ario.devnet.toonprotocol.dev/ilp",
        "the store must advertise ITS OWN public edge, not the apex's -- \
         advertising the apex's endpoint here would just relocate the \
         mismatch from identity to endpoint"
    );
    assert_eq!(
        announce.identity_key_file(),
        None,
        "the store has no prior publisher identity to carry over (issue \
         #799 does not apply here -- see the config's own comment); it must \
         sign with its own [signer], not a carried-over key"
    );
    assert_eq!(
        announce.relay_url(),
        None,
        "the store fronts no relay and must not advertise reads it does not serve"
    );
}

/// Issue #843's core property, mirroring #833's for the store: the relay
/// box's `[announce]` must claim ONLY prefixes it actually terminates.
/// Asserted over the committed `[[routes]]` table rather than a literal
/// `"g.toon.relay"` on both sides -- a test that hardcodes the same string
/// twice passes when both are wrong together, which is exactly the shape
/// that let #841 slip past #839's own test (see the module docs and
/// [`the_apex_announcer_never_advertises_a_prefix_it_forwards`] above).
#[test]
fn the_relay_devnet_config_announces_only_prefixes_it_terminates() {
    assert!(
        RELAY_CONFIG.contains("[announce]"),
        "the relay config must carry its own [announce] section -- issue #843"
    );

    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let peer_secret = write_peer_secret();
    let text = with_sandbox_settlement_keys(
        &with_sandbox_paths(
            RELAY_CONFIG,
            key_file.path(),
            state_dir.path(),
            Some(peer_secret.path()),
        ),
        key_file.path(),
    );
    let config_file = write_config(&text);
    let config = Config::load(config_file.path()).expect("the committed relay config must parse");

    let terminated: Vec<&str> = config.routes().iter().map(|r| r.prefix()).collect();
    assert!(
        !terminated.is_empty(),
        "the relay config is expected to terminate at least `g.toon.relay` -- \
         if that changed, this test's premise needs revisiting"
    );

    let announce = config
        .announce()
        .expect("the relay config's [announce] section must parse");
    for address in announce.addresses() {
        assert!(
            terminated.iter().any(|prefix| prefix == address),
            "the relay's [announce] addresses names `{address}`, which the \
             relay's own committed connector-rust.toml does not terminate \
             (terminated prefixes: {terminated:?}) -- announcing a prefix \
             this box does not terminate is issue #833's exact defect \
             reproduced on a new box: a client seals its gift wrap to this \
             node's key and the node that actually holds it (whichever one \
             that is) cannot open it"
        );
    }

    assert_eq!(
        announce.http_endpoint(),
        "https://proxy.relay.devnet.toonprotocol.dev/ilp",
        "the relay must advertise ITS OWN public edge"
    );
    assert_eq!(
        announce.identity_key_file(),
        None,
        "the relay box has no prior publisher identity to carry over (issue \
         #799 does not apply -- this box has never had a kind:10032 \
         publisher of its own); it must sign with its own [signer]"
    );
    assert!(
        announce.relay_url().is_some(),
        "the relay box fronts a relay app (docker-compose.relay.yml) and \
         must advertise it -- omitting relay_url would mean nobody ever \
         hears about its free reads"
    );
    assert!(
        announce.publish_to().is_none(),
        "the relay's announce terminates its own prefix and runs \
         --via-own-routing with an explicit --to on the command line \
         (docker-compose.relay.announce.yml) -- a committed publish_to \
         here would be dead config nothing reads, or worse, silently used \
         if the compose command ever drops --to"
    );
}

/// The trimmed lines of a committed `[announce]` section, or `None` for a
/// file that has no such section -- [`route_price`]'s precedent again, no
/// TOML dependency needed to read a couple of keys written one per line.
fn announce_section(raw: &str) -> Option<Vec<&str>> {
    let mut lines = raw.lines().map(str::trim);
    lines.find(|line| *line == "[announce]")?;
    Some(lines.take_while(|line| !line.starts_with('[')).collect())
}

/// The `addresses = [...]` list of an [`announce_section`], written as one
/// array literal on one line the way every committed file writes it.
fn announce_addresses(section: &[&str]) -> Vec<String> {
    let value = section
        .iter()
        .find_map(|line| line.strip_prefix("addresses"))
        .expect("no `[announce] addresses` line in the committed config text");
    value
        .trim_start()
        .trim_start_matches('=')
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|address| address.trim().trim_matches('"').to_string())
        .filter(|address| !address.is_empty())
        .collect()
}

/// Whether an [`announce_section`] pins `route_store` explicitly. Read off
/// the raw text rather than a loaded `AnnounceConfig`: the loaded value is
/// never absent (`derive_route_hints` always fills it in, pinned or
/// guessed), so only the raw text can tell an explicit pin apart from a
/// silent fallback -- which is exactly the distinction issue #845 is about.
fn announce_pins_route_store(section: &[&str]) -> bool {
    section.iter().any(|line| line.starts_with("route_store"))
}

/// What `derive_route_hints` (`crates/connector-config/src/announce.rs`)
/// would guess for `routes.store` from an address list carrying no
/// `.store`/`.ario` entry, mirroring its fallback rather than approximating
/// it: cut `.relay` off the address it derives `publish` from and append
/// `.store` -- and, when no address ends `.relay` for it to cut, the
/// primary address itself. A guard whose message names a value the real
/// derivation would not produce sends its reader looking for the wrong bug.
fn derived_route_store(addresses: &[String]) -> String {
    let publish = addresses
        .iter()
        .find(|address| address.ends_with(".relay"))
        .or_else(|| addresses.first());
    match publish {
        Some(publish) => publish
            .strip_suffix(".relay")
            .map(|stem| format!("{stem}.store"))
            .unwrap_or_else(|| publish.clone()),
        None => "<no address to guess from>".to_string(),
    }
}

/// Issue #845: the connector-native `[announce]` path has the identical
/// derivation hazard #841 pinned shut on the TypeScript sidecar's
/// `ANNOUNCER_ROUTE_STORE`. `derive_route_hints`
/// (`crates/connector-config/src/announce.rs`) first looks for a
/// `.store`/`.ario` entry in `addresses`; when none exists it falls
/// through to suffix surgery -- strip `.relay` off whichever address it
/// does have and append `.store` -- inventing a prefix with no signal that
/// it was ever guessed. That is exactly how the relay's own announce (only
/// address `g.toon.relay`) derived `routes.store = g.toon.store`, a prefix
/// nothing on this fleet routes (the store prefix is `g.toon.ario`).
///
/// This is the guard the issue asks for: every committed devnet
/// `[announce]` section whose address list contains no `.store`/`.ario`
/// entry must pin `route_store` explicitly, so the fallback never fires
/// unnoticed on this fleet again. The failure message names the file, the
/// key it is missing, and the exact unrouted prefix that key's absence
/// would derive -- the remedy is the message, not a separate lookup.
#[test]
fn every_committed_announce_without_a_store_or_ario_address_pins_route_store() {
    for (label, raw) in [
        ("infra/linode-node/connector-rust.toml", APEX_CONFIG),
        ("infra/linode-store/connector-rust.toml", STORE_CONFIG),
        ("infra/linode-relay/connector-rust.toml", RELAY_CONFIG),
    ] {
        let Some(section) = announce_section(raw) else {
            continue;
        };
        let addresses = announce_addresses(&section);
        let has_store_or_ario = addresses
            .iter()
            .any(|address| address.ends_with(".store") || address.ends_with(".ario"));
        if has_store_or_ario {
            continue;
        }

        let derived = derived_route_store(&addresses);
        assert!(
            announce_pins_route_store(&section),
            "{label}'s [announce] addresses ({addresses:?}) contain no \
             `.store`/`.ario` entry, so `derive_route_hints` falls through \
             to its suffix-surgery fallback and would derive \
             `routes.store = {derived}` -- a prefix nothing on this fleet \
             routes (issue #845, same class as #841's ANNOUNCER_ROUTE_STORE). \
             Pin `route_store` explicitly in this file's [announce] section."
        );
    }
}

/// The `image:` tag every service in a compose overlay pins, read off the
/// committed text -- [`route_price`]'s precedent again, and for the same
/// reason: one line, no YAML dependency.
fn pinned_connector_images(raw: &str) -> Vec<String> {
    raw.lines()
        .map(str::trim)
        .filter_map(|line| line.strip_prefix("image: ghcr.io/toon-protocol/connector:"))
        .map(str::to_string)
        .collect()
}

/// A box's two overlays (the serving `connector-rust` and the scheduled
/// `announce` loop) bind-mount the SAME `connector-rust.toml`, so they must
/// pin the SAME image: the config file and the binary that reads it are one
/// agreement, and `RawConfig` is `deny_unknown_fields` (issue #542). A
/// binary older than a section the file carries does not ignore that
/// section, it exits 1 -- so a stale pin in the announce overlay is not a
/// broken sidecar, it is `docker compose up` recreating the SERVING
/// `connector-rust` from a repo where the two disagree and taking that
/// box's client edge down.
///
/// This is the gate that was missing for the store's pair.
/// `docker-compose.store.announce.yml` was first committed pinning
/// `rust-sha-b31a7c9`, a tag published three hours BEFORE `[announce]` and
/// the `connector announce` verb existed (09bc2299, issue #784) -- a config
/// the binary refuses to load and a subcommand it does not have -- and
/// every existing test passed, because nothing in this suite had any
/// notion of an image tag. Asserted as agreement between the two files
/// rather than against a literal tag so it does not need editing on every
/// routine bump; what it refuses is the two DRIFTING, which is the only
/// shape this failure comes in. Shared by the relay's own pair (issue
/// #843) so the same defect cannot slip past a second time unnoticed.
fn assert_overlays_sharing_one_config_pin_one_image(
    box_label: &str,
    rust_overlay: &str,
    rust_overlay_name: &str,
    announce_overlay: &str,
    announce_overlay_name: &str,
) {
    const CONFIG_MOUNT: &str = "./connector-rust.toml:/app/config/connector.toml";

    for (overlay, name) in [
        (rust_overlay, rust_overlay_name),
        (announce_overlay, announce_overlay_name),
    ] {
        assert!(
            overlay.contains(CONFIG_MOUNT),
            "this test's premise is that both {box_label} overlays mount the \
             SAME `{CONFIG_MOUNT}` -- {name} no longer does, so the \
             agreement it asserts needs rethinking rather than silently \
             holding"
        );
    }

    let serving = pinned_connector_images(rust_overlay);
    let announcing = pinned_connector_images(announce_overlay);
    assert_eq!(
        serving.len(),
        1,
        "{rust_overlay_name} is expected to pin exactly one connector image"
    );
    assert_eq!(
        announcing.len(),
        1,
        "{announce_overlay_name} is expected to pin exactly one connector image"
    );
    assert_eq!(
        announcing[0], serving[0],
        "{announce_overlay_name} pins `{}` while {rust_overlay_name} pins \
         `{}`, and both mount the same connector-rust.toml. The older of the \
         two decides what that file may contain: `deny_unknown_fields` makes \
         an unrecognized section a refuse-to-start, not a warning. Bump the \
         stale one -- do not add a second config",
        announcing[0], serving[0]
    );
    assert!(
        serving[0].starts_with("rust-sha-"),
        "the {box_label} overlays must pin an immutable `rust-sha-` tag, \
         never a floating one (`rust-main`): a floating tag makes the \
         agreement above unfalsifiable"
    );
}

#[test]
fn store_overlays_sharing_one_config_pin_one_image() {
    assert_overlays_sharing_one_config_pin_one_image(
        "store",
        STORE_RUST_OVERLAY,
        "docker-compose.store.rust.yml",
        STORE_ANNOUNCE_OVERLAY,
        "docker-compose.store.announce.yml",
    );
}

/// The relay's own pair (issue #843), same property as the store's above --
/// see [`assert_overlays_sharing_one_config_pin_one_image`].
#[test]
fn relay_overlays_sharing_one_config_pin_one_image() {
    assert_overlays_sharing_one_config_pin_one_image(
        "relay",
        RELAY_RUST_OVERLAY,
        "docker-compose.relay.rust.yml",
        RELAY_ANNOUNCE_OVERLAY,
        "docker-compose.relay.announce.yml",
    );
}

/// Issue #701's carriage negotiation, read across the two boxes: the store
/// announces THROUGH an address the apex owns, and if the apex pins that
/// route to `transport = "btp"` then the store's `[announce]` must carry a
/// `publish_btp_url` -- `pay_the_through_url` takes the carriage from the
/// greeting's `requiredTransport` and, for `btp` with neither `--btp-url`
/// nor `publish_btp_url`, refuses with `NoBtpEndpoint` before anything is
/// signed. The scheduled command in `docker-compose.store.announce.yml`
/// passes no `--btp-url`, so the config is the only place it can come from.
///
/// A property over the apex's committed route table rather than a literal,
/// for the same reason as the announcer test above: the day somebody pins
/// another route to BTP, or unpins this one, the assertion follows the
/// config instead of having to be re-taught.
///
/// The target can be EITHER a terminating route or, as of issue #820, a
/// `peer_id` forward: `publish_to = "g.toon.relay"` used to name a
/// terminating route on the apex, and now names a forward to the relay box.
/// A `peer_id` route can never itself carry `transport` (`PeerRouteHasTransport`
/// refuses it at load), so the ORIGINAL mechanism this test guards
/// (`pay_the_through_url` reading `requiredTransport` off the apex's own
/// greeting) no longer requires a BTP endpoint for this specific target --
/// the apex's greeting for a forward carries no transport requirement at
/// all. `publish_btp_url` is asserted set regardless: it matches what the
/// live box already carries and does not depend on which shape the target
/// route takes today.
#[test]
fn the_store_announce_carries_a_btp_endpoint_when_its_target_route_demands_one() {
    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let peer_secret = write_peer_secret();

    let store_text = with_sandbox_settlement_keys(
        &with_sandbox_paths(
            STORE_CONFIG,
            key_file.path(),
            state_dir.path(),
            Some(peer_secret.path()),
        ),
        key_file.path(),
    );
    let store_file = write_config(&store_text);
    let store = Config::load(store_file.path()).expect("the committed store config must parse");
    let announce = store
        .announce()
        .expect("the store config's [announce] section must parse");
    let publish_to = announce
        .publish_to()
        .expect("the store's [announce] must name a publish_to -- the destination is not guessed");

    let apex_state = tempfile::tempdir().expect("temp state dir");
    let apex_text = with_sandbox_paths(
        &without_live_settlement(APEX_CONFIG),
        key_file.path(),
        apex_state.path(),
        Some(peer_secret.path()),
    );
    let apex_file = write_config(&apex_text);
    let apex = Config::load(apex_file.path()).expect("the committed apex config must parse");

    let terminating_target = apex
        .routes()
        .iter()
        .find(|route| route.prefix() == publish_to);
    let forwarding_target = apex
        .peer_routes()
        .iter()
        .find(|route| route.prefix() == publish_to);

    let needs_a_btp_endpoint = match (terminating_target, forwarding_target) {
        (Some(route), None) => route.transport_policy() == TransportPolicy::Btp,
        // A `peer_id` route cannot itself carry `transport`, so the apex's
        // greeting for a forward never demands BTP -- the endpoint is still
        // required here, but as the repo/live parity the fn doc comment
        // describes rather than as `NoBtpEndpoint` avoidance.
        (None, Some(_)) => true,
        (None, None) => panic!(
            "the store announces through `{publish_to}`, which the apex's \
             committed route table neither terminates nor forwards -- one of \
             the two files moved without the other"
        ),
        (Some(_), Some(_)) => panic!(
            "`{publish_to}` is BOTH a terminating and a forwarding route on \
             the apex -- that is a config-load error waiting to happen, not \
             a state this test should silently pick one side of"
        ),
    };

    if needs_a_btp_endpoint {
        assert!(
            announce.publish_btp_url().is_some(),
            "an announce paid through `{publish_to}` needs a BTP endpoint \
             from either `--btp-url` or `publish_btp_url` -- and the \
             scheduled command in docker-compose.store.announce.yml passes \
             no `--btp-url`. Set `publish_btp_url` in the store's \
             [announce] section"
        );
    }
}

/// The new ERC-2771 `TokenNetwork` (#695/#811) the apex<->store
/// `[[peer_channels]]` row must settle on -- the same address
/// [`APEX_LIVE_REGISTRY`] resolves for client settlement, since the
/// cutover created exactly one new `TokenNetwork` for the fleet's mock USDC
/// (issue #822: the peer channel was deliberately left on the OLD
/// TokenNetwork at cutover time, AC4, and this is the follow-up migration).
const PEER_CHANNEL_LIVE_TOKEN_NETWORK: &str = "0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478";

/// The OLD TokenNetwork the apex<->store channel settled on before issue
/// #822 -- still the correct address for every _historical_ record
/// (`BYTECODE-PROVENANCE.md`, `packages/contracts/deployments*`), but a
/// live `[[peer_channels]]` row naming it is exactly the split-brain #822
/// exists to end.
const PEER_CHANNEL_OLD_TOKEN_NETWORK: &str = "0x1E95493fEF46707E034b4a1945f25a8C76A1823D";

/// Sentinel `channel_id`/`counterparty_key` values (issue #822): the
/// replacement channel does not exist yet, so there is no real channel_id to
/// commit -- opening and funding it against the new `TokenNetwork`, then
/// filling these in on both boxes at once, is a live, human step
/// (`docs/operators/peer-channel-migration.md`), not something this repo
/// diff can do. The pre-cutover channel is deliberately left OPEN on the old
/// contract until that replacement is proven end to end, so its real
/// channel_id must not be carried over here either -- it names a channel
/// whose signing domain this row no longer describes. `0xdead...` rather
/// than the zero address so a reader cannot mistake it for a real,
/// merely-unfunded value.
const PEER_CHANNEL_ID_PLACEHOLDER: &str =
    "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead";
const PEER_CHANNEL_COUNTERPARTY_KEY_PLACEHOLDER: &str =
    "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead";

/// The apex-relay peering's own placeholder (issue #820) -- deliberately a
/// DIFFERENT literal from the apex-store row's above. `ClaimBook`/config
/// load refuses two `[[peer_channels]]` rows naming the same `channel_id`
/// (`ConfigError::PeerChannelDuplicate`), and once the apex carries both
/// peerings in one file that collision is real, not hypothetical -- so a
/// second dead-marker (`...beef` in place of the last `...dead` group,
/// same length) is used rather than reusing the apex-store one verbatim.
const APEX_RELAY_PEER_CHANNEL_ID_PLACEHOLDER: &str =
    "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeadbeef";
const APEX_RELAY_PEER_CHANNEL_COUNTERPARTY_KEY_PLACEHOLDER: &str =
    "0xdeaddeaddeaddeaddeaddeaddeaddeaddeadbeef";

/// Issue #822's repo-side AC: both boxes' `[[peer_channels]]` rows for
/// `apex-store` name the new TokenNetwork, never the old one, and carry the
/// placeholder `channel_id`/`counterparty_key` rather than the retired
/// channel's real values -- a config that quietly kept the old domain, or
/// reused the closed channel's id under the new one, must fail this rather
/// than silently ship a claim the other box cannot resolve or a channel
/// that was never actually opened against this domain.
#[test]
fn the_apex_store_peer_channel_names_the_new_token_network_with_placeholder_fields() {
    for (label, raw) in [("apex", APEX_CONFIG), ("store", STORE_CONFIG)] {
        assert!(
            raw.contains(&format!(
                "token_network = \"{PEER_CHANNEL_LIVE_TOKEN_NETWORK}\""
            )),
            "the {label} config's apex-store [[peer_channels]] row must settle on the new \
             ERC-2771 TokenNetwork ({PEER_CHANNEL_LIVE_TOKEN_NETWORK}) -- both boxes must agree \
             or a claim one accepts is unresolvable by the other"
        );
        assert!(
            !raw.contains(&format!(
                "token_network = \"{PEER_CHANNEL_OLD_TOKEN_NETWORK}\""
            )),
            "the {label} config must not still bind [[peer_channels]] to the OLD TokenNetwork \
             ({PEER_CHANNEL_OLD_TOKEN_NETWORK}) -- that standing two-contract split-brain is \
             exactly what issue #822 ends"
        );
        assert!(
            raw.contains(&format!("channel_id = \"{PEER_CHANNEL_ID_PLACEHOLDER}\"")),
            "the {label} config's apex-store channel_id must be the clearly-marked placeholder \
             until the live migration opens a real channel against the new TokenNetwork -- the \
             retired channel's id must never be reused under a different signing domain"
        );
        assert!(
            raw.contains(&format!(
                "counterparty_key = \"{PEER_CHANNEL_COUNTERPARTY_KEY_PLACEHOLDER}\""
            )),
            "the {label} config's apex-store counterparty_key must be the clearly-marked \
             placeholder until the live migration step fills in the real value"
        );
    }
}

/// Issue #820's own version of the same convention, for the NEW apex-relay
/// peering rather than a migration of an existing one: issue #821 already
/// opened and funded a real channel against the same TokenNetwork, but this
/// repo never commits a peering's live facts (see the apex-store test
/// above) -- both boxes' `[[peer_channels]]` rows for `apex-relay` must
/// carry the clearly-marked placeholder values
/// [`APEX_RELAY_PEER_CHANNEL_ID_PLACEHOLDER`]/
/// [`APEX_RELAY_PEER_CHANNEL_COUNTERPARTY_KEY_PLACEHOLDER`] -- a DIFFERENT
/// literal from the apex-store row's own placeholder, since the apex now
/// carries both rows in one file and `ConfigError::PeerChannelDuplicate`
/// refuses two `[[peer_channels]]` rows naming the same `channel_id`. The
/// real values are applied directly to both boxes' untracked files as part
/// of #820's live cutover.
#[test]
fn the_apex_relay_peer_channel_names_the_new_token_network_with_placeholder_fields() {
    for (label, raw) in [("apex", APEX_CONFIG), ("relay", RELAY_CONFIG)] {
        assert!(
            raw.contains(&format!(
                "token_network = \"{PEER_CHANNEL_LIVE_TOKEN_NETWORK}\""
            )),
            "the {label} config's apex-relay [[peer_channels]] row must settle on the same new \
             ERC-2771 TokenNetwork ({PEER_CHANNEL_LIVE_TOKEN_NETWORK}) the apex-store row uses -- \
             issue #821 opened the real channel against it, so a config naming a different \
             TokenNetwork here would disagree with the channel that actually exists on chain"
        );
        assert!(
            raw.contains(&format!(
                "channel_id = \"{APEX_RELAY_PEER_CHANNEL_ID_PLACEHOLDER}\""
            )),
            "the {label} config's apex-relay channel_id must be the clearly-marked placeholder -- \
             the real value (issue #821) is applied directly to the live boxes, not committed here"
        );
        assert!(
            raw.contains(&format!(
                "counterparty_key = \"{APEX_RELAY_PEER_CHANNEL_COUNTERPARTY_KEY_PLACEHOLDER}\""
            )),
            "the {label} config's apex-relay counterparty_key must be the clearly-marked \
             placeholder, for the same reason as channel_id above"
        );
        assert_ne!(
            APEX_RELAY_PEER_CHANNEL_ID_PLACEHOLDER, PEER_CHANNEL_ID_PLACEHOLDER,
            "the apex-relay and apex-store placeholders must differ -- the apex file carries \
             both rows at once and ConfigError::PeerChannelDuplicate refuses a repeat"
        );
    }
}

/// Issue #701 (toon-meta#262 decision 11): `g.toon.relay` is restricted to
/// BTP -- a high-frequency, always-connected carriage where a persistent
/// session pays off -- while the store legs stay at the default (`both`)
/// for the one-shot anonymous uploads `channels.rs` calls "a first-class
/// path, not a fallback".
///
/// Issue #820 moved that pin off the apex: `transport` is illegal on a
/// `peer_id` route (`ConfigError::PeerRouteHasTransport`), so the apex's
/// `g.toon.relay` forward now carries none, and the pin lives solely on the
/// relay box's own terminating route -- where it gates that box's own client
/// edge and nothing else, since a peer-wire arrival is never transport-checked
/// (docs/devnet-pricing.md's "apex therefore loses client-edge BTP
/// enforcement on this prefix"). This test asserts that split directly: the
/// apex's greeting for `g.toon.relay` no longer names a required transport
/// at all (same shape as the store legs it never restricted), while the
/// relay box's own greeting for the identical prefix still does.
#[tokio::test]
async fn the_relay_route_is_btp_only_and_the_store_routes_accept_both() {
    assert!(
        !APEX_CONFIG.contains("transport = \"btp\""),
        "the apex file must no longer set `transport` anywhere -- issue \
         #820 moved the `g.toon.relay` pin to a `peer_id` route, which \
         cannot carry one (`ConfigError::PeerRouteHasTransport`)"
    );
    assert!(
        RELAY_CONFIG.contains("transport = \"btp\""),
        "the relay box's own file must restrict its terminating route to \
         btp, per issue #701 -- now the ONLY place this prefix enforces it"
    );

    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let peer_secret = write_peer_secret();
    let connector = boot(&with_sandbox_paths(
        &without_live_settlement(APEX_CONFIG),
        key_file.path(),
        state_dir.path(),
        Some(peer_secret.path()),
    ));

    let relay_terms = x402_terms(&connector.client_edge_addr, "g.toon.relay").await;
    assert!(
        relay_terms["accepts"][0]["extra"]
            .get("requiredTransport")
            .is_none(),
        "the apex's own greeting for `g.toon.relay` must not carry \
         requiredTransport any more -- that pin lives on the relay box's \
         own terminating route now, not on this peer_id forward: {relay_terms}"
    );

    let store_terms = x402_terms(&connector.client_edge_addr, "g.toon.ario").await;
    assert!(
        store_terms["accepts"][0]["extra"]
            .get("requiredTransport")
            .is_none(),
        "the store leg left at the default must not carry requiredTransport: {store_terms}"
    );

    let relay_key_file = write_raw_key_file(10);
    let relay_state_dir = tempfile::tempdir().expect("temp state dir");
    let relay_peer_secret = write_peer_secret();
    let relay_connector = boot(&with_sandbox_paths(
        &without_live_settlement(RELAY_CONFIG),
        relay_key_file.path(),
        relay_state_dir.path(),
        Some(relay_peer_secret.path()),
    ));
    let relay_own_terms = x402_terms(&relay_connector.client_edge_addr, "g.toon.relay").await;
    assert_eq!(
        relay_own_terms["accepts"][0]["extra"]["requiredTransport"], "btp",
        "the relay box's own file must require BTP on its own terminating \
         route too: {relay_own_terms}"
    );
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

/// The registry every fleet file's LIVE `[settlement.evm]` section names --
/// the deployed Base Sepolia `TokenNetworkRegistry` (#576, #577), repointed
/// here by the ERC-2771 cutover (#695/#811, broadcast 2026-08-06,
/// `docs/evm-deployment.md`). The anvil cases replace exactly this committed
/// value, so they double as the guard that the committed sections keep
/// naming it; [`every_fleet_configs_settlement_evm_leg_matches_the_live_identity`]
/// below asserts it directly, as parsed, for all three files.
const APEX_LIVE_REGISTRY: &str = "0x8263BdD4eB4862395Cb4ef5dA5d637F4b047Eea1";

/// The retired pre-ERC-2771 `TokenNetworkRegistry` [`APEX_LIVE_REGISTRY`]
/// replaced -- `docs/evm-deployment.md`'s "Current live deployment
/// (pre-cutover)" table and its "Rollback: one step" section, which names
/// this exact address as what a rollback reverts `contract_address` to. Not
/// itself asserted against any committed file; named only so a regression
/// back to it is called out by address in the identity test's failure
/// message, not left for a reader to recognise on sight.
const SETTLEMENT_CONTRACT_ADDRESS_ROLLBACK_TARGET: &str =
    "0xcC9079adE929b168B54145f6d25262b64FAB9D5b";

#[tokio::test]
async fn the_apex_devnet_settlement_section_boots_against_a_deployed_contract() {
    if !require_anvil() {
        return;
    }
    let (anvil, contract_address, token) = deploy_settlement_on_anvil().await;

    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let peer_secret = write_peer_secret();
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
    let text = without_sections(APEX_CONFIG, SOLANA_SETTLEMENT_SECTIONS);
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
    let text = with_sandbox_paths(
        &text,
        key_file.path(),
        state_dir.path(),
        Some(peer_secret.path()),
    );

    drop(boot(&text));
}

/// The apex file's Solana leg (`https://api.devnet.solana.com`) and the
/// deployed `payment-channel` program it settles through, wired in #633 --
/// asserted as literals here, exactly like [`APEX_LIVE_REGISTRY`] and
/// [`EXPECTED_STORE_PRICE`], so that reading the expected values back out of the
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

/// The mock USDC ERC-20 every fleet config's `[settlement.evm]` leg settles
/// in. Unchanged by the #695/#811 ERC-2771 registry cutover -- only the
/// `TokenNetworkRegistry` moved (see [`APEX_LIVE_REGISTRY`]); the token being
/// registered through it did not (`docs/evm-deployment.md`: "never a new
/// token, so no existing balance or faucet distribution is disturbed").
/// [`with_anvil_settlement`] looks for this same literal before retargeting a
/// leg at a freshly deployed mock, so the substitution and this identity
/// check read one constant instead of two copies that could drift apart.
const EXPECTED_SETTLEMENT_TOKEN_ADDRESS: &str = "0x49beE1Bca5d15Fb0963117923403F9498119a9Ce";

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
    let peer_secret = write_peer_secret();
    let text = with_sandbox_paths(
        APEX_CONFIG,
        key_file.path(),
        state_dir.path(),
        Some(peer_secret.path()),
    );
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
    assert_eq!(
        format!("0x{}", hex_lower(evm.token_address().as_slice())).to_lowercase(),
        EXPECTED_SETTLEMENT_TOKEN_ADDRESS.to_lowercase(),
        "the EVM leg must keep naming the fleet's mock USDC"
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

/// Every fleet config's `[settlement.evm]` leg -- apex, store and relay
/// alike -- must name the identical registry, asset and precision: a claim
/// or channel a buyer opened against one `TokenNetworkRegistry`/token is
/// unresolvable by a box pointed at a different one. The boot tests below
/// assert the same property for store/relay with a substring `.contains`
/// check against the committed text; this asserts it as PARSED, typed
/// values against literal constants instead, which is what actually catches
/// a value that merely *looks* right in the text -- `.contains` would still
/// pass on different whitespace, a different case, or a longer address that
/// happens to contain the expected one as a substring.
///
/// Reads no chain and boots nothing, so it runs even where `anvil` is not on
/// `PATH` (unlike the three `*_devnet_settlement_section_boots_against_a_
/// deployed_contract` cases, which are skipped there) -- the same
/// no-network proof [`the_apex_devnet_config_declares_both_committed_
/// settlement_legs`] already relies on for the apex's own Solana leg.
///
/// Failure messages name both the expected literal and the value actually
/// found, per issue #852 -- including calling out
/// [`SETTLEMENT_CONTRACT_ADDRESS_ROLLBACK_TARGET`] by address, so a silent
/// revert to the retired pre-ERC-2771 registry is named rather than just
/// failed.
#[test]
fn every_fleet_configs_settlement_evm_leg_matches_the_live_identity() {
    for (label, raw) in [
        ("apex", APEX_CONFIG),
        ("store", STORE_CONFIG),
        ("relay", RELAY_CONFIG),
    ] {
        let key_file = write_raw_key_file(9);
        let state_dir = tempfile::tempdir().expect("temp state dir");
        let peer_secret = write_peer_secret();
        let text = with_sandbox_paths(
            raw,
            key_file.path(),
            state_dir.path(),
            Some(peer_secret.path()),
        );
        let text = with_sandbox_settlement_keys(&text, key_file.path());
        let config_file = write_config(&text);

        let config = Config::load(config_file.path())
            .unwrap_or_else(|e| panic!("the committed {label} config must parse: {e}"));

        let evm = config
            .settlements()
            .iter()
            .find_map(|settlement| match settlement {
                SettlementConfig::Evm(evm) => Some(evm),
                SettlementConfig::Solana(_) => None,
            })
            .unwrap_or_else(|| panic!("the {label} config must carry a live [settlement.evm] leg"));

        let contract_address = format!("0x{}", hex_lower(evm.contract_address().as_slice()));
        assert_eq!(
            contract_address.to_lowercase(),
            APEX_LIVE_REGISTRY.to_lowercase(),
            "the {label} config's [settlement.evm] contract_address must be the live \
             TokenNetworkRegistry {APEX_LIVE_REGISTRY} (expected), found {contract_address} -- \
             {SETTLEMENT_CONTRACT_ADDRESS_ROLLBACK_TARGET} is the retired pre-ERC-2771 registry \
             and must not be accepted silently"
        );

        let token_address = format!("0x{}", hex_lower(evm.token_address().as_slice()));
        assert_eq!(
            token_address.to_lowercase(),
            EXPECTED_SETTLEMENT_TOKEN_ADDRESS.to_lowercase(),
            "the {label} config's [settlement.evm] token_address must be \
             {EXPECTED_SETTLEMENT_TOKEN_ADDRESS} (expected), found {token_address}"
        );

        assert_eq!(
            evm.decimals(),
            EXPECTED_SETTLEMENT_DECIMALS,
            "the {label} config's [settlement.evm] decimals must be \
             {EXPECTED_SETTLEMENT_DECIMALS} (expected), found {}",
            evm.decimals()
        );
    }
}

/// The store box's settlement is no longer a commented template waiting on a
/// deployment -- it is live, and it names the SAME contracts the apex names,
/// because a claim this node accepts was written against a channel the buyer
/// opened on the shared devnet deployment. A store node pointed at a
/// different registry cannot resolve that channel, so this asserts the two
/// files agree rather than merely that each parses.
#[tokio::test]
async fn the_store_devnet_settlement_section_boots_against_a_deployed_contract() {
    if !require_anvil() {
        return;
    }
    let (anvil, contract_address, token) = deploy_settlement_on_anvil().await;

    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let peer_secret = write_peer_secret();
    // Issue #648: the store config followed the apex onto issue #628's KEYED
    // shape. The legacy flat `[settlement]` + `chain = "evm"` still parses,
    // so nothing below would fail if it slid back -- it would just quietly
    // go on writing a shape the fleet no longer uses, and one that cannot
    // grow a second chain. Asserted here rather than left to a reader's eye.
    assert!(
        STORE_CONFIG.contains("[settlement.evm]")
            && STORE_CONFIG.contains("[settlement.evm.key]")
            && STORE_CONFIG.contains("[settlement.solana]")
            && STORE_CONFIG.contains("[settlement.solana.key]"),
        "the store config must carry both legs on the keyed \
         `[settlement.<chain>]` shape (issue #628, #648), not the legacy \
         flat `[settlement]` table -- an EVM-only store node refuses every \
         Solana-paid write, and this fleet's peering settles on solana:devnet"
    );
    // Line-anchored: the prose above is free to *name* the legacy
    // `chain = "evm"` key while explaining why it is gone, so only an actual
    // uncommented assignment counts.
    assert!(
        !STORE_CONFIG
            .lines()
            .any(|line| line.starts_with("chain = ")),
        "`chain` is the legacy flat shape's discriminator -- a keyed table \
         names its chain by its own key"
    );
    assert!(
        STORE_CONFIG.contains(APEX_LIVE_REGISTRY),
        "the store leg must name the same deployed TokenNetworkRegistry as \
         the apex ({APEX_LIVE_REGISTRY}) -- a buyer's channel lives on one \
         deployment, and a node pointed elsewhere cannot resolve it"
    );
    assert!(
        STORE_CONFIG.contains(APEX_SOLANA_PROGRAM_ID)
            && STORE_CONFIG.contains(APEX_SOLANA_USDC_MINT),
        "the store leg must name the same Solana payment-channel program and \
         mint as the apex, for the same reason"
    );

    // Anvil stands in for Base Sepolia; the Solana leg is stripped for the
    // same reason the apex's is -- there is no local validator in this test.
    let text = without_sections(STORE_CONFIG, SOLANA_SETTLEMENT_SECTIONS);
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
    let text = with_sandbox_paths(
        &text,
        key_file.path(),
        state_dir.path(),
        Some(peer_secret.path()),
    );

    drop(boot(&text));
}

/// The relay box's own live `[settlement.evm]` leg (issue #816/#817), boots
/// against a freshly deployed local chain exactly like the apex's and
/// store's cases above. It names the SAME registry the other two fleet
/// files name: its client edge already accepts an unaffiliated buyer's own
/// on-chain channel (the relay file's own header, issue #556/#611), and
/// that buyer's channel lives on the one shared deployment -- independent of
/// the apex<->relay peering (issue #820) also carried in this file now.
#[tokio::test]
async fn the_relay_devnet_settlement_section_boots_against_a_deployed_contract() {
    if !require_anvil() {
        return;
    }
    let (anvil, contract_address, token) = deploy_settlement_on_anvil().await;

    let key_file = write_raw_key_file(9);
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let peer_secret = write_peer_secret();

    assert!(
        RELAY_CONFIG.contains("[settlement.evm]")
            && RELAY_CONFIG.contains("[settlement.evm.key]")
            && RELAY_CONFIG.contains("[settlement.solana]")
            && RELAY_CONFIG.contains("[settlement.solana.key]"),
        "the relay config must carry both legs on the keyed \
         `[settlement.<chain>]` shape (issue #628), like the apex and store"
    );
    assert!(
        RELAY_CONFIG.contains(APEX_LIVE_REGISTRY),
        "the relay leg must name the same deployed TokenNetworkRegistry as \
         the apex and store ({APEX_LIVE_REGISTRY}) -- a buyer's channel \
         lives on one deployment, and a node pointed elsewhere cannot \
         resolve it"
    );
    assert!(
        RELAY_CONFIG.contains(APEX_SOLANA_PROGRAM_ID)
            && RELAY_CONFIG.contains(APEX_SOLANA_USDC_MINT),
        "the relay leg must name the same Solana payment-channel program and \
         mint as the apex and store, for the same reason"
    );

    // Anvil stands in for Base Sepolia; the Solana leg is stripped for the
    // same reason the apex's and store's are -- there is no local validator
    // in this test.
    let text = without_sections(RELAY_CONFIG, SOLANA_SETTLEMENT_SECTIONS);
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
    let text = with_sandbox_paths(
        &text,
        key_file.path(),
        state_dir.path(),
        Some(peer_secret.path()),
    );

    drop(boot(&text));
}

/// The fleet's **pin of record** (issue #848). This repo's infra compose
/// files decide which `connector` image the fleet runs -- the boxes follow
/// them, not the reverse. #848 was filed while three artifacts named three
/// different tags: the overlays here (`rust-sha-b31a7c9`), the live boxes
/// (`rust-sha-33f10e2`, set by hand) and the store/relay deploy bundles
/// (`rust-sha-bc9749b`). The overlays had since been reconciled to the
/// boxes' `rust-sha-33f10e2` (#837), but nothing asserted that agreement
/// and the tag predates the announce-identity fix. This constant moves
/// them forward off it and makes the agreement a gate.
///
/// The value is a literal, not something derived from `git`, for the same
/// reason every other `EXPECTED_*` constant in this module is: `cargo test`
/// may run from a shallow checkout with no history for `git merge-base` to
/// walk, and a value read back out of the files under test would keep
/// passing if one of them regressed. The evidence for THIS literal was
/// gathered once, by hand, and is recorded here rather than only in a PR
/// diff:
///
/// - `rust-sha-440eab7` is `440eab7b9ff610fb4914d65bb5cbbacb84f2a7ae`, the
///   squash-merge of PR #839, which closes issue #833 -- the
///   announce-identity fix #848 requires the pin of record to carry. The
///   tag IS that commit, so it carries the fix by construction; it is its
///   own evidence.
/// - It is therefore also the EARLIEST tag that qualifies -- no tag built
///   before the fix landed can contain it. The fleet's prior floor,
///   `rust-sha-33f10e2`, is a strict ancestor (`git merge-base
///   --is-ancestor 33f10e2 440eab7b` succeeds), so this is a forward move,
///   not a rollback.
/// - `git merge-base --is-ancestor 440eab7b9ff610fb4914d65bb5cbbacb84f2a7ae
///   HEAD` succeeds as of this change, confirming the tag's commit is on
///   `main`.
///
/// Scope: the legacy TypeScript `connector` services in
/// `docker-compose.node.yml` and `docker-compose.store.yml` pin
/// `3.36.3-solchan.0` and are deliberately NOT converged onto this tag.
/// That is a different binary on its own release-tag scheme, reading a
/// different config file (`connector.yaml`, not `connector-rust.toml`) --
/// pointing it at a `rust-sha-` tag would not start. #848's drift is the
/// `rust-sha-` pins only; retiring those two services is the cutover
/// runbook's job (`docs/operators/rust-cutover-runbook.md`).
///
/// This is a forward move on every box, not yet deployed anywhere -- see
/// each overlay's own "PIN OF RECORD (issue #848)" comment. Re-pin here
/// FIRST on any future bump; the compose files below are asserted to agree
/// with this constant, not the other way around.
const EXPECTED_CONNECTOR_TAG: &str = "rust-sha-440eab7";

/// Every `image:` pin this suite can see across the three-box fleet must
/// name [`EXPECTED_CONNECTOR_TAG`] -- the property #848 exists to hold.
/// Asserted against the literal (not merely "the five agree with each
/// other", which [`store_overlays_sharing_one_config_pin_one_image`] and
/// [`relay_overlays_sharing_one_config_pin_one_image`] already cover) so
/// that all five silently drifting to some OTHER shared tag still fails --
/// the exact shape #848's own investigation found (three artifacts, three
/// different tags, none of them what the boxes ran).
#[test]
fn every_fleet_overlay_pins_the_connector_repos_pin_of_record() {
    let overlays: &[(&str, &str)] = &[
        ("docker-compose.node.rust.yml", APEX_RUST_OVERLAY),
        ("docker-compose.store.rust.yml", STORE_RUST_OVERLAY),
        ("docker-compose.store.announce.yml", STORE_ANNOUNCE_OVERLAY),
        ("docker-compose.relay.rust.yml", RELAY_RUST_OVERLAY),
        ("docker-compose.relay.announce.yml", RELAY_ANNOUNCE_OVERLAY),
    ];

    for (name, overlay) in overlays {
        let pins = pinned_connector_images(overlay);
        assert_eq!(
            pins.len(),
            1,
            "{name} is expected to pin exactly one connector image"
        );
        assert_eq!(
            pins[0], EXPECTED_CONNECTOR_TAG,
            "{name} pins `{}`, expected the fleet's pin of record \
             `{EXPECTED_CONNECTOR_TAG}` (issue #848) -- every Rust connector \
             image reference under infra/ must name the same tag",
            pins[0]
        );
    }
}
