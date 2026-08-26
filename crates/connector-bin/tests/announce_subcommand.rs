//! `connector announce` end to end, against a local stack (issue #784).
//!
//! Unlike `devnet_store_leg_probe.rs`, nothing here needs a fleet, a funded
//! channel, or a single base unit of real value -- and that is the point.
//! The announce path's expensive parts are all reachable locally:
//!
//!   * a REAL `connector` process serving a route that terminates at a
//!     recording HTTP ingress, standing in for a relay's `POST /write`;
//!   * a REAL free negotiation over HTTP against that process's client
//!     edge -- the unpaid PREPARE, the 402 x402 greeting, and
//!     `GET /ilp/identity`;
//!   * a REAL kind:10032 event, signed BIP-340 Schnorr with the node's own
//!     `[signer]` identity key, gift-wrapped (ADR 0018) under a condition
//!     derived from the wrap's shared secret (ADR 0019);
//!   * a REAL `Connector::handle_prepare` in the announcing process --
//!     the same call `POST /packets` makes -- carrying that packet to the
//!     ingress, which keeps the bytes it was handed.
//!
//! What is deliberately NOT here is a peering. Paying a *remote* connector
//! for the carriage needs two nodes, two channels and a claim exchange
//! (`two_connectors_peer.rs`'s territory), and none of it changes anything
//! this file is about: the announce originates through `handle_prepare`
//! either way, and the routing table decides the rest.

use std::io::{Read, Write};
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

use chrono::Duration as ChronoDuration;
use connector_runtime::OutboundClientLedger;
use connector_settlement::SettlementBackend;
use connector_settlement_evm::test_support::{require_anvil, Anvil, DEPLOYER_PRIVATE_KEY};
use connector_settlement_evm::EvmSettlementBackend;
use connector_signer::{derive_evm_address, to_hex, Signer};

mod support;

/// `anvil`'s own default chain id (`Anvil::spawn --chain-id 31337`), and so
/// the EIP-712 domain a claim against its deployed `TokenNetwork` is signed
/// under.
const ANVIL_CHAIN_ID: u64 = 31_337;

/// This test binary's own base port for [`Anvil::spawn`], distinct from
/// every other test binary's in this workspace (`paid_write_end_to_end.rs`
/// uses `19_000`, `devnet_configs_load.rs` `18_500`, and so on) so
/// concurrent binaries under `cargo test --workspace` do not contend.
const ANVIL_BASE_PORT: u16 = 19_100;

/// What the target connector charges for `g.test.relay`. A client pays
/// exactly this, with no fee arithmetic of its own -- unlike the
/// `--via-own-routing` path, where this hop's own fee is added.
const RELAY_PRICE: u64 = 1000;

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A stand-in for a relay's payment-oblivious write ingress that RECORDS
/// what it was handed.
///
/// `stub-app` would do for "did a packet arrive", but not for "did the
/// signed announce arrive": it answers 200 to any body at all, so a
/// FULFILL against it proves the connector delivered *something*. This
/// keeps the bytes, so the assertion can be about the event's own id.
///
/// Hand-rolled over a `TcpListener` rather than pulled in as another test
/// dependency: it serves exactly one request shape (a `POST` with a
/// `content-length`), which is the only shape the connector's app client
/// ever sends.
struct RecordingIngress {
    addr: String,
    received: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl RecordingIngress {
    fn start() -> RecordingIngress {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ingress");
        let addr = listener.local_addr().expect("ingress addr").to_string();
        let received = Arc::new(Mutex::new(Vec::new()));
        let sink = received.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut raw = Vec::new();
                let mut buffer = [0u8; 4096];
                // Read until the headers are complete and the whole
                // `content-length` body has arrived -- the connector's app
                // client always sends one, so there is no chunked case.
                let body = loop {
                    let read = match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break Vec::new(),
                        Ok(read) => read,
                    };
                    raw.extend_from_slice(&buffer[..read]);
                    let Some(split) = raw
                        .windows(4)
                        .position(|window| window == b"\r\n\r\n")
                        .map(|at| at + 4)
                    else {
                        continue;
                    };
                    let headers = String::from_utf8_lossy(&raw[..split]).to_lowercase();
                    let length: usize = headers
                        .split("content-length:")
                        .nth(1)
                        .and_then(|rest| rest.split("\r\n").next())
                        .and_then(|value| value.trim().parse().ok())
                        .unwrap_or(0);
                    if raw.len() - split >= length {
                        break raw[split..split + length].to_vec();
                    }
                };
                sink.lock().expect("ingress lock").push(body);
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\
                      connection: close\r\n\r\n{\"ok\":true}",
                );
                let _ = stream.flush();
            }
        });
        RecordingIngress { addr, received }
    }

    fn bodies(&self) -> Vec<Vec<u8>> {
        self.received.lock().expect("ingress lock").clone()
    }
}

/// Run the compiled `connector` binary with `args` and hand back
/// `(success, stdout, stderr)`. The subcommand is a one-shot: it exits on
/// its own, so unlike `spawn_connector` there is nothing to drain and
/// nothing to kill.
fn run_connector(args: &[&str]) -> (bool, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_connector"))
        .args(args)
        .output()
        .expect("run connector");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    )
}

/// A node that fronts a relay: one terminated route at `handler_url`, and
/// an `[announce]` section describing a node that DOES serve free reads.
///
/// `state_dir` is deliberately absent. A node with no `[[client_channels]]`
/// and no `[[peer_channels]]` has no claim watermark to lose, so config load
/// permits it -- and it is also what makes the "already serving" guard
/// (which exists to stop two processes writing one claim journal) correctly
/// stand aside here.
fn relay_fronting_config(key_path: &Path, handler_url: &str, extra: &str) -> String {
    format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{key_file}"

[[routes]]
prefix = "g.test.relay"
handler_url = "{handler_url}"
price = 1000

[announce]
addresses = ["g.test", "g.test.relay"]
http_endpoint = "https://node.test.example/ilp"
btp_endpoint = "wss://node.test.example/ilp/btp"
relay_url = "wss://relay.test.example"
publish_to = "g.test.relay"
{extra}
"#,
        key_file = key_path.display(),
    )
}

fn write(text: &str) -> tempfile::NamedTempFile {
    let mut file = tempfile::NamedTempFile::new().expect("temp file");
    write!(file, "{text}").expect("write temp file");
    file
}

/// The whole subcommand, end to end, for nothing.
///
/// The chain of evidence, in order: the process exits zero, so the packet
/// FULFILLed and the sealed answer decoded to a 2xx; the summary names the
/// event id and the amount, so the announce was paid for at the price the
/// edge quoted rather than sent free; and the write ingress recorded a body
/// carrying that same event id, verifiably signed by the node's own
/// identity key -- so what arrived is the announce that was signed, not an
/// empty envelope that merely fulfilled.
#[test]
fn an_announce_is_paid_through_the_nodes_own_routing_and_reaches_the_write_ingress() {
    let ingress = RecordingIngress::start();
    let key_file = support::write_raw_key_file(9);
    let config = write(&relay_fronting_config(
        key_file.path(),
        &format!("http://{}/write", ingress.addr),
        "",
    ));
    let node = support::spawn_connector(config.path());

    let through = format!("http://{}/ilp", node.client_edge_addr);
    let (ok, stdout, stderr) = run_connector(&[
        "announce",
        "--config",
        &config.path().display().to_string(),
        &through,
        "--via-own-routing",
    ]);

    assert!(ok, "announce failed:\nstdout: {stdout}\nstderr: {stderr}");
    assert!(
        stdout.contains("announced ") && stdout.contains("g.test.relay"),
        "the summary must name what was announced and where: {stdout}"
    );
    // The route is priced 1000 and terminates on the announcing node
    // itself, so there is no forwarding fee to add: the amount is the
    // quoted price exactly.
    assert!(
        stdout.contains("(1000 base units)"),
        "the summary must name what was paid, at the price the edge quoted: {stdout}"
    );

    let event_id = stdout
        .split("event ")
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next())
        .expect("the summary names the event id")
        .to_string();
    assert_eq!(event_id.len(), 64, "a NIP-01 id is 32 bytes of hex");

    let bodies = ingress.bodies();
    assert_eq!(bodies.len(), 1, "exactly one write reached the ingress");
    // The relay's write ingress wants `{ "event": <signed event> }` and
    // nothing else -- `packages/announcer/src/publisher.ts`'s HTTP path and
    // the relay's own `write-handler.ts`.
    let written: serde_json::Value =
        serde_json::from_slice(&bodies[0]).expect("the ingress was handed JSON");
    assert_eq!(written["event"]["id"], event_id.as_str());
    assert_eq!(written["event"]["kind"], 10032);
    assert_eq!(written["event"]["sig"].as_str().map(str::len), Some(128));
}

/// A dry run negotiates -- so it can quote what the announce would cost --
/// and stops one line short of the only call that spends anything. It is
/// the one shape that is safe to run beside a serving node, which is why
/// the "already serving" guard lets it past.
#[test]
fn a_dry_run_quotes_the_price_and_prints_a_genuinely_signed_event_without_paying() {
    let ingress = RecordingIngress::start();
    let key_file = support::write_raw_key_file(11);
    let config = write(&relay_fronting_config(
        key_file.path(),
        &format!("http://{}/write", ingress.addr),
        "",
    ));
    let node = support::spawn_connector(config.path());

    let (ok, stdout, stderr) = run_connector(&[
        "announce",
        "--config",
        &config.path().display().to_string(),
        &format!("http://{}/ilp", node.client_edge_addr),
        "--dry-run",
    ]);

    assert!(ok, "dry run failed:\nstdout: {stdout}\nstderr: {stderr}");
    assert!(stdout.contains("DRY RUN"), "{stdout}");
    assert!(stdout.contains("1000 base units"), "{stdout}");

    // The printed event is the real thing: kind 10032, a NIP-40 expiration
    // tag, and an `IlpPeerInfo` content carrying exactly the facts the node
    // could not have introspected plus the ones it could.
    let printed: serde_json::Value = serde_json::from_str(
        stdout
            .split_once('{')
            .map(|(_, rest)| format!("{{{rest}"))
            .expect("the dry run prints the event")
            .trim(),
    )
    .expect("the printed event is JSON");
    assert_eq!(printed["kind"], 10032);
    assert_eq!(printed["tags"][0][0], "expiration");

    let info: serde_json::Value =
        serde_json::from_str(printed["content"].as_str().expect("content is a string"))
            .expect("the content is an IlpPeerInfo");
    assert_eq!(info["ilpAddress"], "g.test");
    assert_eq!(
        info["ilpAddresses"],
        serde_json::json!(["g.test", "g.test.relay"])
    );
    assert_eq!(info["httpEndpoint"], "https://node.test.example/ilp");
    assert_eq!(info["btpEndpoint"], "wss://node.test.example/ilp/btp");
    assert_eq!(info["relayUrl"], "wss://relay.test.example");
    // Read from this node's own routing table rather than polled off an
    // edge over HTTP, which is the whole saving of being in-process.
    assert_eq!(info["routePrices"]["g.test.relay"], "1000");
    assert_eq!(info["routes"]["publish"], "g.test.relay");
    // No `[settlement.*]` table on this node, so there is nothing to
    // advertise -- and the fields are ABSENT rather than empty, so a parser
    // written before they existed is unaffected.
    assert!(info.get("supportedChains").is_none(), "{info}");
    assert!(info.get("settlementAddresses").is_none(), "{info}");
    // This route is left at the permissive default (issue #701), so there
    // is no transport requirement to declare -- and the same "absent, not
    // empty" rule applies to it.
    assert!(info.get("requiredTransport").is_none(), "{info}");
}

/// A route pinned `transport = "btp"` (issue #701) SAYS SO on the announce.
///
/// The requirement was enforced from the day #701 landed and advertised
/// from none of them: verified live 2026-08-14 against the devnet fleet on
/// `connector:rust-sha-415531a`, the relay box terminates `g.toon.relay`
/// with `transport = "btp"` and its kind:10032 carried no
/// `requiredTransport` key at all -- nor did any other announce in the
/// corpus. toon-client's `terminatorRequiresBtp` guard (toon-client#558)
/// reads exactly this key off the raw content, so with the key missing it
/// could never fire: every client fell through to HTTP-ILP and was refused
/// by the very policy the announce should have warned it about.
///
/// The key is asserted at the ROOT of the content on purpose. The x402
/// greeting nests the same fact under `extra.requiredTransport`, and a
/// kind:10032 content has no `extra` block -- nesting it here would satisfy
/// a reader's memory of the greeting and nothing else.
#[test]
fn a_btp_only_route_declares_the_transport_it_requires_on_the_announce() {
    let ingress = RecordingIngress::start();
    let key_file = support::write_raw_key_file(23);
    let config = write(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{key_file}"

[[routes]]
prefix = "g.test.relay"
handler_url = "http://{ingress}/write"
price = 1000
transport = "btp"

[announce]
addresses = ["g.test.relay"]
http_endpoint = "https://node.test.example/ilp"
btp_endpoint = "wss://node.test.example/ilp/btp"
publish_to = "g.test.relay"
"#,
        key_file = key_file.path().display(),
        ingress = ingress.addr,
    ));
    let node = support::spawn_connector(config.path());

    let (ok, stdout, stderr) = run_connector(&[
        "announce",
        "--config",
        &config.path().display().to_string(),
        &format!("http://{}/ilp", node.client_edge_addr),
        "--dry-run",
    ]);

    assert!(ok, "dry run failed:\nstdout: {stdout}\nstderr: {stderr}");
    let printed: serde_json::Value = serde_json::from_str(
        stdout
            .split_once('{')
            .map(|(_, rest)| format!("{{{rest}"))
            .expect("the dry run prints the event")
            .trim(),
    )
    .expect("the printed event is JSON");
    let info: serde_json::Value =
        serde_json::from_str(printed["content"].as_str().expect("content is a string"))
            .expect("the content is an IlpPeerInfo");

    assert_eq!(
        info["requiredTransport"], "btp",
        "the transport policy is read off this node's own `[[routes]]`, the same table the \
         price came from: {info}"
    );
    assert!(
        info.get("extra").is_none(),
        "toon-client reads JSON.parse(content)['requiredTransport'] off the root, not out of \
         an `extra` block (which a kind:10032 content does not have): {info}"
    );
}

/// #784's `relay_url` rule, at the far end of the pipe: a node that fronts
/// no relay announces without the field rather than pointing at somebody
/// else's. The devnet store box is exactly this node.
#[test]
fn a_node_fronting_no_relay_announces_no_relay_url() {
    let ingress = RecordingIngress::start();
    let key_file = support::write_raw_key_file(13);
    let config = write(
        &relay_fronting_config(
            key_file.path(),
            &format!("http://{}/write", ingress.addr),
            "",
        )
        .replace("relay_url = \"wss://relay.test.example\"\n", ""),
    );
    let node = support::spawn_connector(config.path());

    let (ok, stdout, stderr) = run_connector(&[
        "announce",
        "--config",
        &config.path().display().to_string(),
        &format!("http://{}/ilp", node.client_edge_addr),
        "--dry-run",
    ]);

    assert!(ok, "dry run failed:\nstdout: {stdout}\nstderr: {stderr}");
    assert!(
        !stdout.contains("relayUrl"),
        "a node that fronts no relay must omit the field entirely, not emit it empty: {stdout}"
    );
}

/// A config with nothing to announce refuses by name rather than
/// announcing a node it can only half describe.
#[test]
fn announcing_without_an_announce_section_refuses_by_name() {
    let key_file = support::write_raw_key_file(15);
    let config = write(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"
"#,
        key_file.path().display()
    ));

    let (ok, _stdout, stderr) = run_connector(&[
        "announce",
        "--config",
        &config.path().display().to_string(),
        "http://127.0.0.1:1/ilp",
        "--to",
        "g.test.relay",
    ]);

    assert!(!ok);
    assert!(stderr.contains("[announce] section"), "{stderr}");
}

/// The one place this implementation departs from #784's text, asserted so
/// it cannot be quietly "fixed" into a guess: the x402 greeting's `payTo`
/// echoes the destination it was asked about, so it can confirm a
/// destination but never supply one. With neither `--to` nor
/// `[announce] publish_to`, the command refuses and says where to find the
/// address.
#[test]
fn announcing_with_no_destination_refuses_and_says_where_the_address_comes_from() {
    let key_file = support::write_raw_key_file(17);
    let config = write(
        &relay_fronting_config(key_file.path(), "http://127.0.0.1:1/", "")
            .replace("publish_to = \"g.test.relay\"\n", ""),
    );

    let (ok, _stdout, stderr) = run_connector(&[
        "announce",
        "--config",
        &config.path().display().to_string(),
        "http://127.0.0.1:1/ilp",
    ]);

    assert!(!ok);
    assert!(stderr.contains("--to"), "{stderr}");
    assert!(
        stderr.contains("routes.publish"),
        "the message must name where an operator already has this address: {stderr}"
    );
}

/// A config whose `g.test.relay` is FORWARDED over a peering rather than
/// terminated here -- the only shape in which an announce signs an outbound
/// claim, and therefore the only shape the ledger guard is about.
///
/// `client_edge_addr` names `port` so the guard's "is a connector already
/// serving this config" question has something to find.
fn forwarding_config(key_path: &Path, secret_path: &Path, state_dir: &Path, port: u16) -> String {
    format!(
        r#"
client_edge_addr = "127.0.0.1:{port}"
state_dir = "{state_dir}"

[signer]
key_file = "{key_file}"

[[peers]]
id = "carrier"
endpoint = "wss://carrier.test.example/ilp/btp"
credential = {{ secret_file = "{secret_file}" }}
# What this node retains for carrying one packet over this peering (ADR
# 0010, ADR 0061). It rides here, not on the `[[routes]]` row below, and
# `amount_to_pay` reads it through the route's `peer_id`.
fee = 2

[[peer_channels]]
peer_id = "carrier"
channel_id = "0xaaaabbbbccccddddeeeeffff00001111aaaabbbbccccddddeeeeffff00001111"
counterparty_key = "0x00000000000000000000000000000000000000aa"
chain_id = 84532
token_network = "0x00000000000000000000000000000000000000bb"

[[routes]]
prefix = "g.test.relay"
peer_id = "carrier"
price = 1002

# ADR 0042, and required since issue #1145: a peering this node FORWARDS to
# must name the channel it pays that hop from, because there is no postpay
# path left for an uncovered forward to fall back to. One channel in both
# roles with one hop is the deployed shape, so this is the peer row's own
# channel.
[[pay_channels]]
peer_id = "carrier"
channel_id = "0xaaaabbbbccccddddeeeeffff00001111aaaabbbbccccddddeeeeffff00001111"
chain_id = 84532
token_network = "0x00000000000000000000000000000000000000bb"
client_edge_url = "https://carrier.test.example/ilp"

[announce]
addresses = ["g.test.ario"]
http_endpoint = "https://node.test.example/ilp"
btp_endpoint = "wss://node.test.example/ilp/btp"
publish_to = "g.test.relay"

# An EVM `[[peer_channels]]` row needs `[settlement.evm]` (issue #1138):
# a peer claim is redeemed by the channel's on-chain participant, and that
# address is this table's key -- the same key ADR 0024's outbound peer
# claims are signed with, which is what this fixture is about.
[settlement.evm]
rpc_url = "http://127.0.0.1:8545"
contract_address = "0x1234567890123456789012345678901234567890"
token_address = "0x49beE1Bca5d15Fb0963117923403F9498119a9Ce"
decimals = 6

[settlement.evm.key]
key_file = "{key_file}"
"#,
        state_dir = state_dir.display(),
        key_file = key_path.display(),
        secret_file = secret_path.display(),
    )
}

/// The guard that stops the worst thing this subcommand could do.
///
/// A node's outbound peer-claim ledger is replayed from `state_dir`'s
/// journal at startup and held in memory; the journal has no lock. Two
/// processes over one `state_dir` both resume at nonce N, both sign N+1,
/// and the counterparty refuses one as a replay -- after which the serving
/// node's claims stop advancing the far side's watermark and the peering
/// silently stops being paid. So an announce that would FORWARD over a
/// peering refuses while this config's client edge is listening.
///
/// Driven with a plain listener rather than a connector process because the
/// guard's question is exactly "is anything listening there" -- which keeps
/// the test about the rule and not about a race to bind a port.
#[test]
fn announcing_beside_a_serving_node_refuses_rather_than_forking_the_claim_journal() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let key_file = support::write_raw_key_file(19);
    let secret = write("a-real-peering-secret");
    let config = write(&forwarding_config(
        key_file.path(),
        secret.path(),
        state_dir.path(),
        port,
    ));

    let (ok, _stdout, stderr) = run_connector(&[
        "announce",
        "--config",
        &config.path().display().to_string(),
        "http://127.0.0.1:1/ilp",
        "--via-own-routing",
    ]);

    assert!(!ok);
    assert!(stderr.contains("already serving"), "{stderr}");
    assert!(
        stderr.contains("--dry-run"),
        "the message must name the escape that is safe beside a running node: {stderr}"
    );
}

/// The same guard, asked about the ledger that MOVED (issue #873, this is
/// issue #876's AC1).
///
/// `OutboundClientLedger` now lives in `connector-runtime`, and its
/// file-backed form is a **second** book of money state under a serving
/// node's `state_dir` -- one whose nonce floor two processes replaying the
/// same file would both resume from and both advance to N+1. The guard
/// above predates that book, so this test asks the guard's question with
/// the relocated book actually present and standing where a serving node's
/// own would:
///
///   * the seed is read back through `OutboundClientLedger::open` itself,
///     so what is on disk is the relocated ledger and not merely a file
///     shaped like one;
///   * the announce is refused BY NAME -- delete
///     `refuse_if_a_second_process_would_fork_the_ledger` (or its call in
///     `announce`) and this fails on the "already serving" assertion, which
///     is the whole point of the test;
///   * and the refused process leaves the relocated ledger byte-identical,
///     so the refusal lands *before* a second writer exists rather than
///     after one has already advanced a nonce.
///
/// Deliberately NOT a second copy of the peer-journal test above: that one
/// proves the guard fires at all, this one proves the book #873 introduced
/// is behind it.
#[test]
fn a_second_process_is_refused_before_it_can_fork_the_relocated_outbound_client_ledger() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let state_dir = tempfile::tempdir().expect("temp state dir");

    // A serving node's outbound client ledger, mid-life: it has already
    // issued nonce 7 to the `carrier` peering this config forwards over.
    let ledger_path = state_dir.path().join("outbound-client.ndjson");
    std::fs::write(&ledger_path, "{\"nextHop\":\"carrier\",\"nonce\":7}\n")
        .expect("seed the relocated ledger");
    assert_eq!(
        OutboundClientLedger::open(&ledger_path)
            .expect("the seed must be a ledger the relocated book can read")
            .issued_nonce("carrier"),
        7,
        "the fixture has to be the real relocated ledger, or this test guards nothing"
    );
    let before = std::fs::read(&ledger_path).expect("read the seeded ledger");

    let key_file = support::write_raw_key_file(19);
    let secret = write("a-real-peering-secret");
    let config = write(&forwarding_config(
        key_file.path(),
        secret.path(),
        state_dir.path(),
        port,
    ));

    let (ok, _stdout, stderr) = run_connector(&[
        "announce",
        "--config",
        &config.path().display().to_string(),
        "http://127.0.0.1:1/ilp",
        "--via-own-routing",
    ]);

    assert!(!ok, "a second writer over one state_dir must not succeed");
    assert!(
        stderr.contains("already serving"),
        "the guard must refuse this by name -- if this line is what failed, the fork guard is \
         gone and a second process can now advance the relocated ledger's nonce line: {stderr}"
    );
    assert!(
        stderr.contains("--dry-run"),
        "the message must name the escape that is safe beside a running node: {stderr}"
    );
    assert_eq!(
        std::fs::read(&ledger_path).expect("read the ledger back"),
        before,
        "the refused process must leave the relocated ledger exactly as it found it"
    );
    assert_eq!(
        OutboundClientLedger::open(&ledger_path)
            .expect("the ledger must still be readable")
            .issued_nonce("carrier"),
        7,
        "no nonce may have been issued on the serving node's line"
    );
}

/// The DEFAULT send path, against a real chain: this node pays the
/// through-URL directly, as an ordinary client of it.
///
/// This is the shape #784's owner asked for twice -- "an operator announces
/// to a relay whose URL they provide, **paying like any other client**" --
/// and the whole point is what it does NOT need. The announcing config has:
///
///   * **no route to `g.test.relay`**, or to anything at all;
///   * **no `[[peers]]`** and so nothing to originate over;
///   * **no `[[client_channels]]`** -- that table is channels a node
///     RECEIVES on, and this node is paying.
///
/// What it has is a funded channel with the target and a settlement
/// identity, which is exactly what any buyer has. That is what makes this
/// reachable from a node like the devnet store box, whose peering is
/// accept-only and which has no `g.toon.relay` route.
///
/// Every value here is real: a real `anvil` chain, a real registry-resolved
/// `TokenNetwork`, a real on-chain deposit, a real EIP-712 balance proof
/// recovered by the far side's own claim gate, and a real
/// `POST /ilp/claim-state` round trip for the watermark. Nothing is mocked
/// and no real-money network is touched.
#[tokio::test]
async fn the_default_path_pays_the_through_url_as_a_client_with_no_route_and_no_peering() {
    // Fail loudly in CI when the chain this needs is unavailable, never
    // silently skip and report success (issue #471's policy).
    if !require_anvil() {
        return;
    }
    let anvil = Anvil::spawn(ANVIL_BASE_PORT).await;
    let token =
        EvmSettlementBackend::deploy_mock_token(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
            .await
            .expect("mint a fresh mock ERC-20");
    let backend = EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
        .await
        .expect("deploy a TokenNetwork through a fresh registry");
    let registry = backend.registry_address();

    // The announcing node's own settlement identity. Its EVM address is the
    // channel participant -- there is no second key anywhere in this test,
    // which is the property `[announce] pay_channel` is designed around.
    let announcer_secret = [37u8; 32];
    let announcer_address = derive_evm_address(
        &libsecp256k1::PublicKey::from_secret_key(
            &libsecp256k1::SecretKey::parse(&announcer_secret).expect("valid secret"),
        )
        .serialize(),
    );

    // A real channel, funded on chain with real value, whose counterparty
    // the chain itself records as the announcing node.
    let channel = backend
        .open(announcer_address.to_vec(), ChronoDuration::hours(1))
        .await
        .expect("open a real channel");
    // The announcing node is the one that signs, so the collateral goes on
    // its side of the channel -- which on a real deployment it deposits
    // itself, and which the fixture-only delegate deposit stands in for
    // here (issue #1118).
    let funded = backend
        .fund_counterparty(&channel, 10 * u128::from(RELAY_PRICE))
        .await
        .expect("fund it with real ERC-20 value");
    assert_eq!(funded.counterparty_deposited, 10 * u128::from(RELAY_PRICE));

    // The TARGET: a connector fronting a relay write ingress, with a real
    // settlement section against the same deployment -- so it can resolve
    // the channel above from chain and judge a claim on it (issue #502's
    // registration-free path: nothing in its config names this buyer).
    let ingress = RecordingIngress::start();
    let target_key = support::write_raw_key_file(41);
    let target_settlement = write(DEPLOYER_PRIVATE_KEY);
    let target_state = tempfile::tempdir().expect("temp state dir");
    let target_config = write(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"
state_dir = "{state_dir}"

[signer]
key_file = "{key_file}"

[settlement.evm]
rpc_url = "{rpc_url}"
contract_address = "{registry:?}"
token_address = "{token:?}"
decimals = 6

[settlement.evm.key]
key_file = "{settlement_key}"

[[routes]]
prefix = "g.test.relay"
handler_url = "http://{ingress}/write"
price = {RELAY_PRICE}

# Issue #701: the same app behind a prefix pinned to ONE carriage -- the
# shape the live devnet apex gives `g.toon.relay`. A paid HTTP request here
# is answered with x402 terms rather than served, however correct the claim,
# because `handle_ilp` checks transport before it checks payment.
[[routes]]
prefix = "g.test.btponly"
handler_url = "http://{ingress}/write"
price = {RELAY_PRICE}
transport = "btp"
"#,
        state_dir = target_state.path().display(),
        key_file = target_key.path().display(),
        settlement_key = target_settlement.path().display(),
        rpc_url = anvil.rpc_url,
        ingress = ingress.addr,
    ));
    let target = support::spawn_connector(target_config.path());

    // The ANNOUNCING node. Note what is absent: no `[[routes]]`, no
    // `[[peers]]`, no `[[client_channels]]`, no `state_dir`. It cannot
    // route a packet anywhere -- and does not need to.
    let announcer_key = support::write_raw_key_file(43);
    let announcer_settlement = write(&hex_encode(&announcer_secret));
    let announcer_config = write(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{key_file}"

[settlement.evm]
rpc_url = "{rpc_url}"
contract_address = "{registry:?}"
token_address = "{token:?}"
decimals = 6

[settlement.evm.key]
key_file = "{settlement_key}"

[announce]
addresses = ["g.test.ario"]
http_endpoint = "https://ario.test.example/ilp"
btp_endpoint = "wss://ario.test.example/ilp/btp"
publish_to = "g.test.relay"
pay_channel = "{channel_id}"
"#,
        key_file = announcer_key.path().display(),
        settlement_key = announcer_settlement.path().display(),
        rpc_url = anvil.rpc_url,
        channel_id = channel.0,
    ));

    let (ok, stdout, stderr) = run_connector(&[
        "announce",
        "--config",
        &announcer_config.path().display().to_string(),
        &format!("http://{}/ilp", target.client_edge_addr),
    ]);

    assert!(
        ok,
        "the client send path failed:\nstdout: {stdout}\nstderr: {stderr}"
    );
    assert!(
        stdout.contains(&format!("({RELAY_PRICE} base units)")),
        "a client pays exactly what the edge quotes, with no fee arithmetic of its own: {stdout}"
    );

    // The event reached the relay's write ingress, through a connector this
    // node has no route to and no peering with.
    let bodies = ingress.bodies();
    assert_eq!(bodies.len(), 1, "exactly one write reached the ingress");
    let written: serde_json::Value =
        serde_json::from_slice(&bodies[0]).expect("the ingress was handed JSON");
    assert_eq!(written["event"]["kind"], 10032);
    let info: serde_json::Value = serde_json::from_str(
        written["event"]["content"]
            .as_str()
            .expect("content is a string"),
    )
    .expect("the content is an IlpPeerInfo");
    assert_eq!(info["ilpAddress"], "g.test.ario");
    // The settlement facts announced are the ANNOUNCING node's own, read
    // from its own verified `[settlement.evm]` table -- not the target's,
    // even though both point at one deployment here and the addresses that
    // differ are exactly the ones that matter.
    assert_eq!(
        info["settlementAddresses"][format!("evm:{ANVIL_CHAIN_ID}")],
        to_hex(&announcer_address)
    );

    // And the value genuinely moved: the target's claim gate accepted a
    // claim on the channel, so its own claim state now reports the
    // watermark this announce advanced it to. Read back over the same
    // public endpoint the announce used, signed by the same key.
    let state = claim_state(
        &format!("http://{}/ilp", target.client_edge_addr),
        &channel.0,
        &announcer_secret,
        backend.address().to_fixed_bytes(),
    )
    .await;
    assert_eq!(state["ok"], true, "{state}");
    assert_eq!(
        state["cumulativeClaimed"],
        RELAY_PRICE.to_string(),
        "the accepted claim advanced the channel by exactly the route's price: {state}"
    );
    assert_eq!(state["nonce"], 1, "{state}");

    // ── and now the same thing over BTP ──────────────────────────────────
    //
    // `g.test.btponly` is pinned `transport = "btp"` (issue #701), the shape
    // the live devnet apex gives `g.toon.relay`. Three things are under test
    // here and each was a way to get this wrong:
    //
    //   1. the carriage is chosen by NEGOTIATION -- the greeting's
    //      `requiredTransport` -- not by being told, so the same command
    //      that just used HTTP now uses BTP without a mode flag;
    //   2. the claim rides as `payment-channel-claim` protocolData as RAW
    //      JSON, where the HTTP carriage base64s the identical bytes into a
    //      header. Getting that backwards is a refused claim on a paid
    //      packet;
    //   3. the watermark is shared across carriages. This second announce
    //      must advance the SAME channel to nonce 2 and 2x the price --
    //      which also proves the first one really was accepted, since a
    //      claim that did not advance would now collide.
    let (ok, stdout, stderr) = run_connector(&[
        "announce",
        "--config",
        &announcer_config.path().display().to_string(),
        &format!("http://{}/ilp", target.client_edge_addr),
        "--to",
        "g.test.btponly",
        "--btp-url",
        &format!("ws://{}/ilp/btp", target.client_edge_addr),
    ]);
    assert!(
        ok,
        "the BTP carriage failed:\nstdout: {stdout}\nstderr: {stderr}"
    );
    assert_eq!(ingress.bodies().len(), 2, "a second write reached the app");

    let state = claim_state(
        &format!("http://{}/ilp", target.client_edge_addr),
        &channel.0,
        &announcer_secret,
        backend.address().to_fixed_bytes(),
    )
    .await;
    assert_eq!(
        state["cumulativeClaimed"],
        (2 * RELAY_PRICE).to_string(),
        "the BTP claim advanced the same channel by exactly the price again: {state}"
    );
    assert_eq!(state["nonce"], 2, "{state}");
}

/// The BTP endpoint is explicit input, and the refusal has to say where an
/// operator finds it -- because the one place it is NOT is the greeting.
///
/// Verified live against the devnet apex: `extra` carries exactly
/// `endpoint` (the HTTP one), `ilpAddress`, `price`, `requiredTransport`,
/// `sessionLeaseTtlMs`, `settlement` and `settlements`. Deriving the BTP URL
/// by swapping the HTTP one's scheme and appending a path would be right on
/// this fleet and wrong for any operator whose deployment does not mirror
/// it -- the same class of guess `relay_url` and `payTo` already punished --
/// so it is refused rather than invented.
#[tokio::test]
async fn a_btp_only_route_with_no_btp_url_refuses_and_says_where_to_find_one() {
    if !require_anvil() {
        return;
    }
    let anvil = Anvil::spawn(ANVIL_BASE_PORT).await;
    let token =
        EvmSettlementBackend::deploy_mock_token(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
            .await
            .expect("mint a mock ERC-20");
    let backend = EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
        .await
        .expect("deploy a TokenNetwork");

    let ingress = RecordingIngress::start();
    let target_key = support::write_raw_key_file(51);
    let target_settlement = write(DEPLOYER_PRIVATE_KEY);
    let target_state = tempfile::tempdir().expect("temp state dir");
    let target_config = write(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"
state_dir = "{state_dir}"

[signer]
key_file = "{key_file}"

[settlement.evm]
rpc_url = "{rpc_url}"
contract_address = "{registry:?}"
token_address = "{token:?}"
decimals = 6

[settlement.evm.key]
key_file = "{settlement_key}"

[[routes]]
prefix = "g.test.btponly"
handler_url = "http://{ingress}/write"
price = {RELAY_PRICE}
transport = "btp"
"#,
        state_dir = target_state.path().display(),
        key_file = target_key.path().display(),
        settlement_key = target_settlement.path().display(),
        rpc_url = anvil.rpc_url,
        registry = backend.registry_address(),
        ingress = ingress.addr,
    ));
    let target = support::spawn_connector(target_config.path());

    let announcer_key = support::write_raw_key_file(53);
    let announcer_settlement = write(&hex_encode(&[59u8; 32]));
    let announcer_config = write(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{key_file}"

[settlement.evm]
rpc_url = "{rpc_url}"
contract_address = "{registry:?}"
token_address = "{token:?}"
decimals = 6

[settlement.evm.key]
key_file = "{settlement_key}"

[announce]
addresses = ["g.test.ario"]
http_endpoint = "https://ario.test.example/ilp"
btp_endpoint = "wss://ario.test.example/ilp/btp"
publish_to = "g.test.btponly"
pay_channel = "0x{channel}"
"#,
        key_file = announcer_key.path().display(),
        settlement_key = announcer_settlement.path().display(),
        rpc_url = anvil.rpc_url,
        registry = backend.registry_address(),
        channel = "ab".repeat(32),
    ));

    let (ok, _stdout, stderr) = run_connector(&[
        "announce",
        "--config",
        &announcer_config.path().display().to_string(),
        &format!("http://{}/ilp", target.client_edge_addr),
    ]);

    assert!(!ok);
    assert!(stderr.contains("requires the 'btp' transport"), "{stderr}");
    assert!(
        stderr.contains("CANNOT be derived"),
        "the message must refuse to guess, not merely fail: {stderr}"
    );
    assert!(
        stderr.contains("kind:10032") && stderr.contains("btpEndpoint"),
        "the message must name where an operator actually finds it: {stderr}"
    );
    // Refused before anything was signed or sent: the app saw nothing.
    assert!(ingress.bodies().is_empty());
}

/// Read one channel's claim state off a live client edge, the way the
/// announce path itself does -- an EIP-712 challenge signed by the channel
/// participant, over a digest deliberately distinct from a balance proof's.
async fn claim_state(
    edge: &str,
    channel_hex: &str,
    secret: &[u8; 32],
    token_network: [u8; 20],
) -> serde_json::Value {
    let signer =
        connector_signer::LocalSigner::from_secret_bytes("readback", *secret).expect("signer");
    let channel_id: [u8; 32] = {
        let text = channel_hex.strip_prefix("0x").unwrap_or(channel_hex);
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex");
        }
        out
    };
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs()
        + 60;
    let signature = signer
        .sign(&connector_signer::evm_claim_state_challenge_digest(
            &connector_signer::EvmClaimStateChallenge {
                channel_id,
                expires,
                chain_id: ANVIL_CHAIN_ID,
                token_network_address: token_network,
            },
        ))
        .expect("sign")
        .to_bytes();

    let body: serde_json::Value = reqwest::Client::new()
        .post(format!("{edge}/claim-state"))
        .json(&serde_json::json!({"channels": [{
            "blockchain": "evm",
            "channelId": format!("0x{}", hex_encode(&channel_id)),
            "expires": expires,
            "signature": format!("0x{}", hex_encode(&signature)),
        }]}))
        .send()
        .await
        .expect("POST /ilp/claim-state")
        .json()
        .await
        .expect("claim-state JSON");
    body["channels"][0].clone()
}

/// ...and the guard stops exactly there. An announce to a route this node
/// TERMINATES signs no outbound claim -- `forward_via_peer_route` is the
/// only thing that does -- so there is no ledger to fork and no reason to
/// refuse, even with a `state_dir` and a listening client edge.
///
/// This is not a corner: it is the apex publishing to its own relay, which
/// is the shape most nodes that front a relay will use. A guard that
/// refused it would refuse the common case to prevent a hazard the common
/// case does not have, and a guard like that is one operators route around.
#[test]
fn announcing_a_locally_terminated_route_is_allowed_beside_a_serving_node() {
    let ingress = RecordingIngress::start();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let occupied = listener.local_addr().expect("addr").port();
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let key_file = support::write_raw_key_file(21);

    // The node this announce actually negotiates with, on its own port.
    let serving = write(&relay_fronting_config(
        key_file.path(),
        &format!("http://{}/write", ingress.addr),
        "",
    ));
    let node = support::spawn_connector(serving.path());

    // The announcing process reads a config that claims the OCCUPIED port
    // as its own client edge and keeps durable state -- so the guard's
    // first and third conditions both hold, and only "would this forward
    // over a peering" is false.
    let announcing = write(
        &relay_fronting_config(
            key_file.path(),
            &format!("http://{}/write", ingress.addr),
            "",
        )
        .replace(
            "client_edge_addr = \"127.0.0.1:0\"",
            &format!(
                "client_edge_addr = \"127.0.0.1:{occupied}\"\nstate_dir = \"{}\"",
                state_dir.path().display()
            ),
        ),
    );

    let (ok, stdout, stderr) = run_connector(&[
        "announce",
        "--config",
        &announcing.path().display().to_string(),
        &format!("http://{}/ilp", node.client_edge_addr),
        "--via-own-routing",
    ]);

    assert!(
        ok,
        "a terminated-route announce must not be blocked:\nstdout: {stdout}\nstderr: {stderr}"
    );
    assert!(stdout.contains("announced "), "{stdout}");
    assert_eq!(ingress.bodies().len(), 1);
}
