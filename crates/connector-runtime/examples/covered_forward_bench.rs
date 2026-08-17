//! Issue #1033 / ADR 0031's deferred throughput question: "the throughput
//! question is open and must be measured before rollout reaches the
//! huddles workload." This is that measurement, for the **send** side of a
//! covered forward -- `Connector::cover_forward` (issue #881) -- which
//! `peer_claim_journal_bench.rs` (issue #879, ADR 0033) does not exercise
//! at all: that file drives `handle_peer_prepare`, the RECEIVE side of an
//! inbound peer claim, never `with_outbound_client_hop`. An exhaustive
//! grep of this workspace at the time this file was written finds exactly
//! two callers of `with_outbound_client_hop`: `connector.rs`'s own tests,
//! and this bench -- issue #1019 (wiring it from `[[peers]]` config) has
//! not landed, so the covered forward path has never run outside a unit
//! test before now.
//!
//! `cover_forward`'s own doc names the cost precisely: "one watermark round
//! trip to the receiver and the one durable nonce reservation
//! `OutboundClientLedger::next_claim` makes, on every packet" -- a fourth
//! cost on top of issue #879's measured 3.00 `fdatasync`/packet for the
//! covering-claim-plus-exposure receive path (ADR 0033's table). This file
//! measures that fourth cost directly, on the send side, real network round
//! trip and real disk write included -- nothing here is stubbed.
//!
//! # Three modes
//!
//! | mode                | outbound client hop configured | ledger        | watermark round trip | durable nonce write |
//! | -------------------- | ------------------------------ | ------------- | --------------------- | -------------------- |
//! | `uncovered`          | no                              | n/a           | no                     | no (peer ledger's own claim-signing write instead -- see below) |
//! | `covered`            | yes                             | file-backed   | yes                    | yes                   |
//! | `covered-in-memory`  | yes                             | in-memory     | yes                    | no                    |
//!
//! `uncovered` is ADR 0004's postpay convention, pre-#881: `cover_forward`
//! returns `NotConfigured` and the packet rides the peer ledger's
//! `pending_claim`, exactly as `forward_via_peer_route` did before issue
//! #881 existed. It is not a zero-cost baseline -- a fulfilled forward
//! still signs and durably journals a peer-ledger claim via
//! `ClaimBook::record_fulfillment` -- but that write lands on a different
//! book (`ClaimBook`'s own journal) than the covered path's
//! (`OutboundClientLedger`'s file), and it spends no HTTP round trip. It is
//! the real "before issue #881" cost, not an artificial one.
//!
//! Diffing `covered` against `covered-in-memory` isolates the outbound
//! ledger's own `fdatasync` from the watermark round trip's cost, the same
//! "toggle one thing, measure the delta" method ADR 0033 used to isolate
//! its own third `fdatasync` (`record_inbound_delivery`, kept vs retired).
//!
//! Every watermark call's own wall-clock time is ALSO recorded directly (a
//! thin wrapper around the real `HttpClaimState`, timing its own call and
//! nothing else), so the watermark round trip's contribution is reported,
//! not inferred from a subtraction -- issue #1033's second acceptance
//! criterion. `--fresh-client` answers its third question, "what a
//! persistent session changes, if anything": normally the receiver is
//! asked over one `reqwest::Client` reused for the whole run (real
//! keep-alive pooling, the shape production wiring would use if it reused
//! one client per hop); `--fresh-client` opens a brand new `reqwest::Client`
//! -- so a fresh TCP connection, no pooled keep-alive -- for every single
//! watermark call instead.
//!
//! # Counting the syscalls
//!
//! ```text
//! cargo build --release --example covered_forward_bench -p connector-runtime
//! strace -c -f -e trace=fsync,fdatasync \
//!   ./target/release/examples/covered_forward_bench --mode covered --packets 500 --rate 0
//! ```
//!
//! Divide the `fdatasync` count by `--packets`. Count with `--rate 0` and
//! drop `strace` for the latency run, exactly as issue #879 did.
//!
//! # Measuring the latency
//!
//! ```text
//! ./target/release/examples/covered_forward_bench --mode covered --packets 2940 --rate 49
//! ```
//!
//! 2940 packets at 49/s is 60 seconds of a huddle. The reported latency is
//! measured around `handle_prepare` alone -- sealing a packet is the
//! upstream sender's cost and is done up front, outside the timed loop.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::{Duration as ChronoDuration, Utc};
use connector_config::StaticRoute;
use connector_domain::{
    derive_condition, EnvelopeRequest, EnvelopeResponse, PacketResponse, Prepare,
};
use connector_runtime::{
    AppOutcome, ChannelDomain, ClaimStateSource, ClaimWatermark, Connector, EvmDomain,
    FakeAppClient, FileJournal, HttpClaimState, InProcessPeerTransport, OutboundClientError,
    OutboundClientLedger, PeerRoute, SystemClock,
};
use connector_signer::giftwrap::{derive_fulfillment, seal_request};
use connector_signer::{Address, LocalSigner, Signer};
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Request, Response, Server};

/// The prefix box 1 forwards over its peer route, and the address every
/// packet is ultimately destined for on the downstream box.
const DESTINATION: &str = "g.bench.app";
/// The peer id box 1 forwards to.
const DOWNSTREAM_PEER: &str = "peer-downstream";
/// Every packet carries the same amount; the peer route's fee is zero, so
/// this is also what is forwarded and what each claim covers.
const AMOUNT: u64 = 1_000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Uncovered,
    Covered,
    CoveredInMemory,
}

impl Mode {
    fn parse(raw: &str) -> Option<Mode> {
        match raw {
            "uncovered" => Some(Mode::Uncovered),
            "covered" => Some(Mode::Covered),
            "covered-in-memory" => Some(Mode::CoveredInMemory),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Mode::Uncovered => "uncovered",
            Mode::Covered => "covered",
            Mode::CoveredInMemory => "covered-in-memory",
        }
    }
}

struct Args {
    mode: Mode,
    packets: usize,
    rate: f64,
    journal_dir: Option<String>,
    fresh_client: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut mode = Mode::Covered;
    let mut packets = 500usize;
    let mut rate = 0.0f64;
    let mut journal_dir = None;
    let mut fresh_client = false;

    let mut argv = std::env::args().skip(1);
    while let Some(flag) = argv.next() {
        let mut value = || argv.next().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--mode" => {
                let raw = value()?;
                mode = Mode::parse(&raw).ok_or_else(|| format!("unknown mode '{raw}'"))?;
            }
            "--packets" => packets = value()?.parse().map_err(|_| "--packets is a number")?,
            "--rate" => rate = value()?.parse().map_err(|_| "--rate is a number")?,
            "--journal-dir" => journal_dir = Some(value()?),
            "--fresh-client" => fresh_client = true,
            "--help" | "-h" => {
                println!(
                    "covered_forward_bench \
                     --mode <uncovered|covered|covered-in-memory> \
                     [--packets N] [--rate PACKETS_PER_SEC] [--journal-dir DIR] \
                     [--fresh-client]"
                );
                std::process::exit(0);
            }
            other => return Err(format!("unknown flag '{other}'")),
        }
    }
    Ok(Args {
        mode,
        packets,
        rate,
        journal_dir,
        fresh_client,
    })
}

/// The 32-byte on-chain channel id `n`, hex, as the peer wire spells one.
fn channel_id(n: u8) -> String {
    format!("0x{n:064x}")
}

/// The peer-role channel domain box 1 signs its `uncovered`-mode claims
/// under (`ClaimBook`'s own book).
fn peer_channel_domain() -> ChannelDomain {
    ChannelDomain {
        chain_id: 31_337,
        token_network_address: Address::from([0x11; 20]),
    }
}

/// The receiver's EIP-712 domain box 1's outbound CLIENT ledger signs
/// covering claims under -- `EvmDomain`, not `ChannelDomain`: see
/// `outbound_client`'s module header for why the two books, and their two
/// domain types, must never merge.
fn client_evm_domain() -> EvmDomain {
    EvmDomain {
        chain_id: 31_337,
        token_network: [0x22; 20],
    }
}

/// The downstream box: a real `Connector` terminating `DESTINATION` at an
/// app that answers `200`. It gets no journal, so every `fdatasync` this
/// process makes belongs to box 1.
fn downstream_box(identity: Arc<dyn Signer>) -> Arc<Connector> {
    let route = StaticRoute::new(DESTINATION, "http://localhost:4000").expect("static route");
    let app_client = Arc::new(FakeAppClient::new());
    app_client.respond(
        route.handler_url(),
        AppOutcome::Answered {
            response: EnvelopeResponse {
                status: 200,
                headers: vec![],
                body: b"ok".to_vec(),
            },
        },
    );
    Arc::new(
        Connector::new(
            vec![route],
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            Arc::new(SystemClock),
        )
        .with_identity_signer(identity),
    )
}

/// A PREPARE sealed to `identity`, whose execution condition matches the
/// fulfilment its own sealed secret derives -- so it fulfils when it
/// reaches an app that answers at all (ADR 0019).
fn sealed_prepare(identity: &dyn Signer) -> Prepare {
    let plaintext = EnvelopeRequest {
        method: "POST".to_string(),
        target: "/".to_string(),
        headers: vec![],
        body: b"frame".to_vec(),
    }
    .encode();
    let (data, shared_secret) =
        seal_request(&plaintext, &identity.public_key().expect("public key")).expect("seal");
    Prepare {
        amount: AMOUNT,
        expires_at: Utc::now() + ChronoDuration::hours(1),
        execution_condition: derive_condition(&derive_fulfillment(&shared_secret)),
        destination: DESTINATION.to_string(),
        data,
    }
}

/// A real HTTP server standing in for the next hop's `POST
/// /ilp/claim-state` -- a genuine socket round trip, over loopback TCP,
/// same as `outbound_client.rs`'s own test `Receiver`. It answers a fixed,
/// generous watermark: nothing here redeems a claim, so there is nothing
/// for the answer to track, and `OutboundClientLedger`'s own local nonce
/// floor is what keeps every issued nonce distinct regardless (see its
/// module header).
async fn start_claim_state_receiver() -> (String, tokio::sync::oneshot::Sender<()>) {
    let make = make_service_fn(|_conn| async {
        Ok::<_, Infallible>(service_fn(|_req: Request<Body>| async {
            Ok::<_, Infallible>(Response::new(Body::from(
                serde_json::json!({
                    "channels": [{
                        "ok": true,
                        "nonce": 0,
                        "cumulativeClaimed": "0",
                        "available": "100000000000000",
                    }]
                })
                .to_string(),
            )))
        }))
    });
    let server = Server::bind(&SocketAddr::from(([127, 0, 0, 1], 0))).serve(make);
    let url = format!("http://{}/ilp", server.local_addr());
    let (shutdown, stop) = tokio::sync::oneshot::channel();
    tokio::spawn(server.with_graceful_shutdown(async {
        let _ = stop.await;
    }));
    (url, shutdown)
}

/// Wraps the real [`HttpClaimState`] to record each watermark call's own
/// wall-clock time -- nothing about the call itself is changed, so what is
/// timed is exactly the round trip `cover_forward` pays.
///
/// `fresh_client_per_call` answers issue #1033's "what a persistent
/// session changes" question: `false` (the default) reuses one
/// `reqwest::Client` -- and therefore one pooled, kept-alive connection --
/// for the whole run, same as a real `HttpClaimState` held for a hop's
/// lifetime would; `true` opens a brand new client, and therefore a fresh
/// TCP connection, on every single call.
struct TimedClaimState {
    client: reqwest::Client,
    edge_url: String,
    signer: Arc<dyn Signer>,
    fresh_client_per_call: bool,
    timings: Mutex<Vec<Duration>>,
}

#[async_trait]
impl ClaimStateSource for TimedClaimState {
    async fn watermark(
        &self,
        channel: &[u8; 32],
        domain: &EvmDomain,
    ) -> Result<ClaimWatermark, OutboundClientError> {
        let started = Instant::now();
        let result = if self.fresh_client_per_call {
            let fresh = reqwest::Client::new();
            HttpClaimState::new(&fresh, &self.edge_url, self.signer.as_ref())
                .watermark(channel, domain)
                .await
        } else {
            HttpClaimState::new(&self.client, &self.edge_url, self.signer.as_ref())
                .watermark(channel, domain)
                .await
        };
        self.timings
            .lock()
            .expect("timings lock poisoned")
            .push(started.elapsed());
        result
    }
}

/// `q`th quantile of an already-sorted slice, by nearest rank.
fn quantile(sorted: &[Duration], q: f64) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    let rank = (q * sorted.len() as f64).ceil() as usize;
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

fn micros(d: Duration) -> f64 {
    d.as_secs_f64() * 1_000_000.0
}

fn print_latency_table(label: &str, latencies: &[Duration]) {
    println!(
        "{label}_p50_us        {:.1}",
        micros(quantile(latencies, 0.50))
    );
    println!(
        "{label}_p90_us        {:.1}",
        micros(quantile(latencies, 0.90))
    );
    println!(
        "{label}_p99_us        {:.1}",
        micros(quantile(latencies, 0.99))
    );
    println!(
        "{label}_mean_us       {:.1}",
        latencies.iter().copied().map(micros).sum::<f64>() / latencies.len().max(1) as f64
    );
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(err) => {
            eprintln!("covered_forward_bench: {err}");
            std::process::exit(2);
        }
    };

    let identity: Arc<dyn Signer> = Arc::new(LocalSigner::generate("bench-downstream-identity"));
    let box_1_signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("bench-box-1-signer"));

    let mut transport = InProcessPeerTransport::new();
    transport.add_peer(DOWNSTREAM_PEER, downstream_box(identity.clone()));

    let journal_dir = match &args.journal_dir {
        Some(dir) => std::path::PathBuf::from(dir),
        None => std::env::temp_dir().join(format!("connector-1033-{}", std::process::id())),
    };
    std::fs::create_dir_all(&journal_dir).expect("journal dir");

    let mut builder = Connector::new(
        vec![],
        vec![PeerRoute::new("g.bench", DOWNSTREAM_PEER, 0)],
        Arc::new(FakeAppClient::new()),
        Arc::new(transport),
        Arc::new(SystemClock),
    )
    .with_signer(box_1_signer.clone());

    let (claim_state_url, _receiver_shutdown) = start_claim_state_receiver().await;
    let timed_state = Arc::new(TimedClaimState {
        client: reqwest::Client::new(),
        edge_url: claim_state_url,
        // The claim-state challenge is signed by the same settlement key
        // `cover_forward` itself would use (`ClaimBook::signer`) -- box 1
        // has exactly one signer, configured just above.
        signer: box_1_signer,
        fresh_client_per_call: args.fresh_client,
        timings: Mutex::new(Vec::new()),
    });

    let mut journal_path = None;
    match args.mode {
        Mode::Uncovered => {
            let path = journal_dir.join(format!("{}.journal", args.mode.name()));
            let _ = std::fs::remove_file(&path);
            builder = builder
                .with_peer_claim_channel(DOWNSTREAM_PEER, channel_id(2))
                .with_channel_domain(channel_id(2), peer_channel_domain())
                .expect("channel 2 is a valid on-chain channel id")
                .with_journal(Arc::new(FileJournal::open(&path).expect("open journal")))
                .expect("journal replay");
            journal_path = Some(path);
        }
        Mode::Covered => {
            let path = journal_dir.join("outbound-client.log");
            let _ = std::fs::remove_file(&path);
            let ledger = Arc::new(OutboundClientLedger::open(&path).expect("open outbound ledger"));
            builder = builder
                .with_outbound_client_ledger(ledger)
                .with_outbound_client_hop(
                    DOWNSTREAM_PEER,
                    channel_id(3),
                    client_evm_domain(),
                    timed_state.clone(),
                )
                .expect("channel 3 is a valid on-chain channel id");
            journal_path = Some(path);
        }
        Mode::CoveredInMemory => {
            let ledger = Arc::new(OutboundClientLedger::in_memory());
            builder = builder
                .with_outbound_client_ledger(ledger)
                .with_outbound_client_hop(
                    DOWNSTREAM_PEER,
                    channel_id(3),
                    client_evm_domain(),
                    timed_state.clone(),
                )
                .expect("channel 3 is a valid on-chain channel id");
        }
    }
    let box_1 = builder;

    // Sender-side work, done up front so it is not inside the timed loop:
    // sealing a packet happens on another box in a real deployment.
    let prepares: Vec<Prepare> = (0..args.packets)
        .map(|_| sealed_prepare(identity.as_ref()))
        .collect();

    let mut latencies: Vec<Duration> = Vec::with_capacity(args.packets);
    let mut fulfilled = 0usize;
    let interval = (args.rate > 0.0).then(|| Duration::from_secs_f64(1.0 / args.rate));

    let run_started = Instant::now();
    for (i, prepare) in prepares.into_iter().enumerate() {
        if let Some(interval) = interval {
            let due = run_started + interval.mul_f64(i as f64);
            let now = Instant::now();
            if due > now {
                tokio::time::sleep(due - now).await;
            }
        }
        let started = Instant::now();
        let response = box_1.handle_prepare(prepare, 0).await;
        latencies.push(started.elapsed());
        if matches!(response, PacketResponse::Fulfill(_)) {
            fulfilled += 1;
        }
    }
    let wall = run_started.elapsed();

    assert_eq!(
        fulfilled,
        latencies.len(),
        "every packet must fulfil, or the disk/network writes counted are not the forward path's"
    );

    latencies.sort_unstable();

    println!("mode                  {}", args.mode.name());
    println!("fresh_client_per_call {}", args.fresh_client);
    println!("packets               {}", latencies.len());
    println!(
        "requested_rate        {}",
        if args.rate > 0.0 {
            format!("{:.1}/s", args.rate)
        } else {
            "unpaced".to_string()
        }
    );
    println!("wall_seconds          {:.3}", wall.as_secs_f64());
    println!(
        "achieved_rate         {:.1}/s",
        latencies.len() as f64 / wall.as_secs_f64()
    );
    if let Some(path) = &journal_path {
        let entries = std::fs::read_to_string(path)
            .map(|contents| contents.lines().count())
            .unwrap_or(0);
        println!("journal_entries       {entries}");
        println!(
            "journal_entries/pkt   {:.2}",
            entries as f64 / latencies.len() as f64
        );
        println!("journal_path          {}", path.display());
    } else {
        println!("journal_entries       n/a (in-memory ledger)");
    }
    print_latency_table("latency", &latencies);
    println!(
        "latency_max_us        {:.1}",
        micros(*latencies.last().expect("at least one packet"))
    );

    let mut watermark_timings = timed_state
        .timings
        .lock()
        .expect("timings lock poisoned")
        .clone();
    if !watermark_timings.is_empty() {
        watermark_timings.sort_unstable();
        print_latency_table("watermark", &watermark_timings);
        println!("watermark_calls       {}", watermark_timings.len());
    }
}
