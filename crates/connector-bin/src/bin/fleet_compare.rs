//! `fleet-compare`: side-by-side comparison harness for two fleets (issue
//! #491, parent #431). Drives the same packet sequence at two client edges
//! and reports where they diverge -- see `connector::fleet_compare` for
//! what gets normalized and why. Exits non-zero if any packet diverged, so
//! it can gate a migration decision in CI as well as be read by a human.
//!
//! Usage:
//! ```text
//! fleet-compare \
//!     --fleet-a-url http://127.0.0.1:PORT_A --fleet-a-prefix g.old \
//!     --fleet-b-url http://127.0.0.1:PORT_B --fleet-b-prefix g.new \
//!     --packets packets.json
//! ```
//!
//! `--packets` points at a JSON array of packet specs (see
//! `connector::fleet_compare::PacketSpec` for the schema). The same file
//! works unchanged whether the two URLs are two locally-spawned fleets on
//! different ports, or two devnet gateways under two different prefixes --
//! only the `--fleet-*-url`/`--fleet-*-prefix` flags change; nothing here
//! hardcodes local addressing.

use connector::fleet_compare::{
    any_diverged, compare, render_report, run_sequence, FleetTarget, PacketSpec,
};

fn usage() -> ! {
    eprintln!(
        "usage: fleet-compare --fleet-a-url <url> --fleet-a-prefix <prefix> \
         --fleet-b-url <url> --fleet-b-prefix <prefix> --packets <path.json>"
    );
    std::process::exit(1);
}

struct Args {
    fleet_a_url: String,
    fleet_a_prefix: String,
    fleet_b_url: String,
    fleet_b_prefix: String,
    packets_path: String,
}

fn parse_args(raw: &[String]) -> Args {
    let mut fleet_a_url = None;
    let mut fleet_a_prefix = None;
    let mut fleet_b_url = None;
    let mut fleet_b_prefix = None;
    let mut packets_path = None;

    let mut iter = raw.iter();
    while let Some(flag) = iter.next() {
        let Some(value) = iter.next() else { usage() };
        match flag.as_str() {
            "--fleet-a-url" => fleet_a_url = Some(value.clone()),
            "--fleet-a-prefix" => fleet_a_prefix = Some(value.clone()),
            "--fleet-b-url" => fleet_b_url = Some(value.clone()),
            "--fleet-b-prefix" => fleet_b_prefix = Some(value.clone()),
            "--packets" => packets_path = Some(value.clone()),
            _ => usage(),
        }
    }

    let (
        Some(fleet_a_url),
        Some(fleet_a_prefix),
        Some(fleet_b_url),
        Some(fleet_b_prefix),
        Some(packets_path),
    ) = (
        fleet_a_url,
        fleet_a_prefix,
        fleet_b_url,
        fleet_b_prefix,
        packets_path,
    )
    else {
        usage()
    };

    Args {
        fleet_a_url,
        fleet_a_prefix,
        fleet_b_url,
        fleet_b_prefix,
        packets_path,
    }
}

#[tokio::main]
async fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let args = parse_args(&raw);

    let packets_json = std::fs::read_to_string(&args.packets_path).unwrap_or_else(|err| {
        eprintln!("failed to read {}: {err}", args.packets_path);
        std::process::exit(1);
    });
    let packets: Vec<PacketSpec> = serde_json::from_str(&packets_json).unwrap_or_else(|err| {
        eprintln!("failed to parse {}: {err}", args.packets_path);
        std::process::exit(1);
    });

    let fleet_a = FleetTarget {
        client_edge_url: args.fleet_a_url,
        prefix: args.fleet_a_prefix,
    };
    let fleet_b = FleetTarget {
        client_edge_url: args.fleet_b_url,
        prefix: args.fleet_b_prefix,
    };

    let client = reqwest::Client::new();
    let outcomes_a = run_sequence(&client, &fleet_a, &packets).await;
    let outcomes_b = run_sequence(&client, &fleet_b, &packets).await;

    let comparisons = compare(&packets, &fleet_a, &outcomes_a, &fleet_b, &outcomes_b);
    print!("{}", render_report(&comparisons));

    if any_diverged(&comparisons) {
        std::process::exit(1);
    }
}
