//! Issue #879: how many `fdatasync` calls does one forwarded peer packet
//! cost, and what does that cost at the buzz-huddles rate (49 packets per
//! second)?
//!
//! This drives a real [`Connector`] over its real peer-forward path, with a
//! real [`FileJournal`] on a real filesystem, so the syscalls are the ones
//! the connector actually makes -- `strace` counts them from the outside,
//! nothing here counts them for itself. Nothing is stubbed on the money
//! path: the inbound claims are signed by a second, real [`ClaimBook`]
//! standing in for the upstream node (the same `record_fulfillment` a peer
//! signs its own claims with), the downstream peer is a second real
//! `Connector` reached over [`InProcessPeerTransport`], and the outbound
//! claim box 1 signs per forward is signed by a real [`LocalSigner`].
//!
//! Four modes, which together separate the journal's two writers:
//!
//! | mode                   | inbound claim | exposure recorded | journal entries per packet              |
//! | ---------------------- | ------------- | ----------------- | --------------------------------------- |
//! | `baseline`             | no            | no                | `OutboundClaimSigned`                    |
//! | `window`               | no            | yes               | `InboundFulfillmentRecorded` + outbound  |
//! | `covering`             | yes           | yes               | `InboundClaimAccepted` + both above      |
//! | `covering-no-exposure` | yes           | no                | `InboundClaimAccepted` + outbound        |
//!
//! `window` is the peer path as it ships today (issue #868's own reading of
//! `handle_peer_prepare`: a claimless PREPARE is admitted, and only the
//! exposure it opens is journalled). `covering` is #868's rule laid on top
//! of the exposure machinery unchanged. `covering-no-exposure` is #868's
//! rule with `record_inbound_delivery` retired, which is the choice its
//! acceptance criteria leave open.
//!
//! # The ceiling is set explicitly, on purpose
//!
//! `PeerConfig::ceiling`'s doc claims `None` means "the runtime's own
//! default"; there is no such default (`connector-cli/src/runtime.rs`
//! configures a ceiling only when the config carries one), so an unset
//! ceiling makes `is_over_ceiling` answer `false` without ever reading the
//! projection. That is a different code path from a configured peering, so
//! this harness always sets one (`--ceiling`, default large enough that no
//! run trips it): what is measured is the **bounded** path.
//!
//! # Counting the syscalls
//!
//! ```text
//! cargo build --release --example peer_claim_journal_bench -p connector-runtime
//! strace -c -f -e trace=fsync,fdatasync \
//!   ./target/release/examples/peer_claim_journal_bench --mode window --packets 500 --rate 0
//! ```
//!
//! Divide the `fdatasync` count by `--packets`. Count with `--rate 0`
//! (pacing only adds sleeps) and drop `strace` for the latency run, since
//! ptrace inflates every syscall it stops on.
//!
//! # Measuring the latency
//!
//! ```text
//! ./target/release/examples/peer_claim_journal_bench --mode covering --packets 2940 --rate 49
//! ```
//!
//! 2940 packets at 49/s is 60 seconds of a huddle. The reported latency is
//! measured around `handle_peer_prepare` alone -- sealing a packet and
//! signing the claim that covers it are the *sender's* costs and are done
//! up front, outside the timed loop, exactly as they happen on another box
//! in a real deployment.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{Duration as ChronoDuration, Utc};
use connector_config::StaticRoute;
use connector_domain::{
    derive_condition, EnvelopeRequest, EnvelopeResponse, PacketResponse, Prepare,
};
use connector_runtime::{
    AppOutcome, ChannelDomain, ClaimBook, Connector, FakeAppClient, FileJournal,
    InProcessPeerTransport, PeerRoute, SystemClock, WireClaim,
};
use connector_signer::giftwrap::{derive_fulfillment, seal_request};
use connector_signer::{derive_evm_address, Address, LocalSigner, Signer};

/// The prefix box 1 forwards over its peer route, and the address every
/// packet is ultimately destined for on box 2.
const DESTINATION: &str = "g.bench.app";
/// The peer id box 1 forwards to. Not any deployment's peer id -- nothing
/// here is written to any config.
const DOWNSTREAM_PEER: &str = "peer-downstream";
/// The peer id box 1 is known by upstream, used only to key the upstream
/// `ClaimBook`'s outbound ledger.
const UPSTREAM_SELF: &str = "box-1";
/// Every packet carries the same amount; the peer route's fee is zero, so
/// this is also what is forwarded and what each claim covers.
const AMOUNT: u64 = 1_000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Baseline,
    Window,
    Covering,
    CoveringNoExposure,
}

impl Mode {
    fn parse(raw: &str) -> Option<Mode> {
        match raw {
            "baseline" => Some(Mode::Baseline),
            "window" => Some(Mode::Window),
            "covering" => Some(Mode::Covering),
            "covering-no-exposure" => Some(Mode::CoveringNoExposure),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Mode::Baseline => "baseline",
            Mode::Window => "window",
            Mode::Covering => "covering",
            Mode::CoveringNoExposure => "covering-no-exposure",
        }
    }

    /// Whether a covering claim rides every inbound PREPARE.
    fn carries_claim(self) -> bool {
        matches!(self, Mode::Covering | Mode::CoveringNoExposure)
    }

    /// Whether the arrival names its inbound channel, which is what makes
    /// `handle_peer_prepare` record exposure on fulfilment.
    fn records_exposure(self) -> bool {
        matches!(self, Mode::Window | Mode::Covering)
    }
}

struct Args {
    mode: Mode,
    packets: usize,
    rate: f64,
    ceiling: u64,
    journal_dir: Option<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut mode = Mode::Window;
    let mut packets = 500usize;
    let mut rate = 0.0f64;
    // Large enough that no run in this harness trips it, small enough to
    // read: 10^15 of the settlement asset's smallest unit.
    let mut ceiling = 1_000_000_000_000_000u64;
    let mut journal_dir = None;

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
            "--ceiling" => ceiling = value()?.parse().map_err(|_| "--ceiling is a number")?,
            "--journal-dir" => journal_dir = Some(value()?),
            "--help" | "-h" => {
                println!(
                    "peer_claim_journal_bench \
                     --mode <baseline|window|covering|covering-no-exposure> \
                     [--packets N] [--rate PACKETS_PER_SEC] [--ceiling UNITS] [--journal-dir DIR]"
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
        ceiling,
        journal_dir,
    })
}

/// The 32-byte on-chain channel id `n`, hex, as the peer wire spells one.
fn channel_id(n: u8) -> String {
    format!("0x{n:064x}")
}

/// One EIP-712 binding shared by both channels here -- a local chain id and
/// a `TokenNetwork` address that exists nowhere. Nothing is redeemed in
/// this harness; the domain only has to be *some* fixed binding both sides
/// sign and verify against.
fn bench_channel_domain() -> ChannelDomain {
    ChannelDomain {
        chain_id: 31_337,
        token_network_address: Address::from([0x11; 20]),
    }
}

/// The downstream box: a real `Connector` terminating `DESTINATION` at an
/// app that answers `200`. It gets no journal, so every `fdatasync` this
/// process makes belongs to box 1 -- which is why both boxes can share one
/// process without confusing the count.
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

/// The upstream node's own `ClaimBook`, used only to sign the claims that
/// ride into box 1 -- the same `record_fulfillment` path a real peer signs
/// its claims on, so what box 1 verifies is a genuine claim and not a
/// hand-assembled one. Its journal is the default in-memory one, so it
/// costs no syscalls.
fn upstream_claim_source(signer: Arc<dyn Signer>) -> ClaimBook {
    let mut book = ClaimBook::new(
        Some(signer),
        HashMap::from([(UPSTREAM_SELF.to_string(), channel_id(1))]),
        HashMap::new(),
    );
    book.set_channel_domain(channel_id(1), bench_channel_domain())
        .expect("channel 1 is a valid on-chain channel id");
    book
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

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(err) => {
            eprintln!("peer_claim_journal_bench: {err}");
            std::process::exit(2);
        }
    };

    let identity: Arc<dyn Signer> = Arc::new(LocalSigner::generate("bench-downstream-identity"));
    let upstream_signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("bench-upstream-claims"));
    let box_1_signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("bench-box-1-claims"));
    let upstream_address = derive_evm_address(&upstream_signer.public_key().expect("public key"));

    let mut transport = InProcessPeerTransport::new();
    transport.add_peer(DOWNSTREAM_PEER, downstream_box(identity.clone()));

    let journal_dir = match args.journal_dir {
        Some(dir) => std::path::PathBuf::from(dir),
        None => std::env::temp_dir().join(format!("connector-879-{}", std::process::id())),
    };
    std::fs::create_dir_all(&journal_dir).expect("journal dir");
    let journal_path = journal_dir.join(format!("{}.journal", args.mode.name()));
    let _ = std::fs::remove_file(&journal_path);

    let (box_1, divergences) = Connector::new(
        vec![],
        vec![PeerRoute::new("g.bench", DOWNSTREAM_PEER, 0)],
        Arc::new(FakeAppClient::new()),
        Arc::new(transport),
        Arc::new(SystemClock),
    )
    .with_signer(box_1_signer)
    // The channel box 1 signs its own outbound claims against, per forward.
    .with_peer_claim_channel(DOWNSTREAM_PEER, channel_id(2))
    .with_channel_domain(channel_id(2), bench_channel_domain())
    .expect("channel 2 is a valid on-chain channel id")
    // The channel the upstream node's claims arrive on, and the key box 1
    // accepts a signature from on it.
    .with_channel_verification_key(channel_id(1), upstream_address)
    .with_channel_domain(channel_id(1), bench_channel_domain())
    .expect("channel 1 is a valid on-chain channel id")
    // Explicit, so `is_over_ceiling` reads the projection per packet the
    // way a configured peering makes it -- see this file's header.
    .with_channel_ceiling(channel_id(1), args.ceiling)
    .with_journal(Arc::new(
        FileJournal::open(&journal_path).expect("open journal"),
    ))
    .expect("journal replay");
    assert!(divergences.is_empty(), "a fresh journal cannot diverge");

    // Sender-side work, done up front so it is not inside the timed loop:
    // sealing a packet and signing the claim covering it both happen on
    // another box in a real deployment.
    let upstream = upstream_claim_source(upstream_signer);
    let mut arrivals: Vec<(Prepare, Option<WireClaim>)> = Vec::with_capacity(args.packets);
    for _ in 0..args.packets {
        let claim = if args.mode.carries_claim() {
            Some(
                upstream
                    .record_fulfillment(UPSTREAM_SELF, AMOUNT, Utc::now())
                    .expect("the upstream node signs a claim"),
            )
        } else {
            None
        };
        arrivals.push((sealed_prepare(identity.as_ref()), claim));
    }

    let arrival_channel = args.mode.records_exposure().then(|| channel_id(1));
    let mut latencies: Vec<Duration> = Vec::with_capacity(args.packets);
    let mut fulfilled = 0usize;
    let interval = (args.rate > 0.0).then(|| Duration::from_secs_f64(1.0 / args.rate));

    let run_started = Instant::now();
    for (i, (prepare, claim)) in arrivals.into_iter().enumerate() {
        if let Some(interval) = interval {
            let due = run_started + interval.mul_f64(i as f64);
            let now = Instant::now();
            if due > now {
                tokio::time::sleep(due - now).await;
            }
        }
        let started = Instant::now();
        let (response, _ack) = box_1
            .handle_peer_prepare(prepare, 0, claim, arrival_channel.clone())
            .await;
        latencies.push(started.elapsed());
        if matches!(response, PacketResponse::Fulfill(_)) {
            fulfilled += 1;
        }
    }
    let wall = run_started.elapsed();

    assert_eq!(
        fulfilled,
        latencies.len(),
        "every packet must fulfil, or the journal writes counted are not the forward path's"
    );

    let journal_entries = std::fs::read_to_string(&journal_path)
        .expect("read journal")
        .lines()
        .count();
    latencies.sort_unstable();

    println!("mode                  {}", args.mode.name());
    println!("packets               {}", latencies.len());
    println!(
        "requested_rate        {}",
        if args.rate > 0.0 {
            format!("{:.1}/s", args.rate)
        } else {
            "unpaced".to_string()
        }
    );
    println!("ceiling               {}", args.ceiling);
    println!("wall_seconds          {:.3}", wall.as_secs_f64());
    println!(
        "achieved_rate         {:.1}/s",
        latencies.len() as f64 / wall.as_secs_f64()
    );
    println!("journal_entries       {journal_entries}");
    println!(
        "journal_entries/pkt   {:.2}",
        journal_entries as f64 / latencies.len() as f64
    );
    println!("journal_path          {}", journal_path.display());
    println!(
        "latency_p50_us        {:.1}",
        micros(quantile(&latencies, 0.50))
    );
    println!(
        "latency_p90_us        {:.1}",
        micros(quantile(&latencies, 0.90))
    );
    println!(
        "latency_p99_us        {:.1}",
        micros(quantile(&latencies, 0.99))
    );
    println!(
        "latency_p999_us       {:.1}",
        micros(quantile(&latencies, 0.999))
    );
    println!(
        "latency_max_us        {:.1}",
        micros(*latencies.last().expect("at least one packet"))
    );
    println!(
        "latency_mean_us       {:.1}",
        latencies.iter().copied().map(micros).sum::<f64>() / latencies.len() as f64
    );
}
