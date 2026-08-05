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

mod support;

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
ceiling = 1000000

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
fee = 2

[announce]
addresses = ["g.test.ario"]
http_endpoint = "https://node.test.example/ilp"
btp_endpoint = "wss://node.test.example/ilp/btp"
publish_to = "g.test.relay"
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
    ]);

    assert!(!ok);
    assert!(stderr.contains("already serving"), "{stderr}");
    assert!(
        stderr.contains("--dry-run"),
        "the message must name the escape that is safe beside a running node: {stderr}"
    );
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
    ]);

    assert!(
        ok,
        "a terminated-route announce must not be blocked:\nstdout: {stdout}\nstderr: {stderr}"
    );
    assert!(stdout.contains("announced "), "{stdout}");
    assert_eq!(ingress.bodies().len(), 1);
}
