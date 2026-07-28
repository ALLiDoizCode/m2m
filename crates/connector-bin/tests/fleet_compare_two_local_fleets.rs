//! Proves `fleet-compare` (issue #491, parent #431, ADR 0013) against two
//! real, locally-spawned fleets -- each its own `connector` process (built
//! on #488's process-spawning support, `tests/support/mod.rs`) fronting a
//! real `stub-app`.
//!
//! Two things must both be true for this harness to be trusted, per the
//! issue's own review comment: an incidental difference (here, each
//! fleet's own port *and* its own ILP prefix -- deliberately different
//! between fleet A and fleet B in every test below, standing in for "two
//! local ports" vs. "two devnet prefixes") must never be reported, and a
//! real one must always be caught. This file proves both, plus the
//! "pointable at two devnet prefixes without code changes" acceptance
//! criterion: both fleets here already run under different prefixes, and
//! nothing about `fleet_compare` itself changes between a locally-spawned
//! run and a devnet one -- only the [`FleetTarget`] values a caller
//! supplies.

use connector::fleet_compare::{
    any_diverged, compare, condition_hex_for_fulfillment, render_report, run_sequence, FleetTarget,
    PacketSpec,
};

mod support;
use support::{spawn_connector, spawn_stub_app, write_config, write_raw_key_file};

/// Must match `stub_app.rs`'s own fixed `TOON-Fulfillment` value.
const FULFILLMENT: [u8; 32] = [7u8; 32];

/// Must match `stub_app.rs`'s own `DECLINE_BODY` -- separate binaries, no
/// shared constant to import (same note as `two_connectors_and_a_stub_app.rs`).
const DECLINE_BODY: &str = "please decline this one";

/// Bind an ephemeral port and immediately drop the listener, so the
/// returned address is guaranteed to refuse connections -- a real,
/// deterministic "app unreachable" (`T01`) without racing a timeout.
fn dead_addr() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().expect("local addr").to_string()
}

/// A `connector.toml` body for one fleet: `<prefix>.down` always routes to
/// a dead address (proving socket-address normalization), and
/// `<prefix>.app` routes to `app_addr` -- unless `app_addr` is `None`, the
/// deliberate misconfiguration this file's divergence test introduces.
fn connector_config(
    key_path: &std::path::Path,
    prefix: &str,
    app_addr: Option<&str>,
    dead_addr: &str,
) -> String {
    let app_route = match app_addr {
        Some(addr) => {
            format!(
                "\n[[routes]]\nprefix = \"{prefix}.app\"\nhandler_url = \"http://{addr}\"\nprice = 0\n"
            )
        }
        None => String::new(),
    };
    format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{key}"
{app_route}
[[routes]]
prefix = "{prefix}.down"
handler_url = "http://{dead_addr}"
price = 0
"#,
        key = key_path.display(),
    )
}

/// The packet sequence both tests drive: one that fulfils, one the app
/// declines, one whose app is unreachable, and one with no configured
/// route at all -- exercising every `Outcome` variant a real fleet
/// produces, not just the happy path.
fn packet_sequence() -> Vec<PacketSpec> {
    vec![
        PacketSpec {
            label: "fulfils".to_string(),
            destination: "app".to_string(),
            amount: 0,
            expires_in_seconds: 300,
            execution_condition_hex: condition_hex_for_fulfillment(&FULFILLMENT),
            data: "hello from the harness".to_string(),
        },
        PacketSpec {
            label: "app declines".to_string(),
            destination: "app".to_string(),
            amount: 0,
            expires_in_seconds: 300,
            execution_condition_hex: condition_hex_for_fulfillment(&FULFILLMENT),
            data: DECLINE_BODY.to_string(),
        },
        PacketSpec {
            label: "app unreachable".to_string(),
            destination: "down".to_string(),
            amount: 0,
            expires_in_seconds: 300,
            execution_condition_hex: condition_hex_for_fulfillment(&FULFILLMENT),
            data: "irrelevant".to_string(),
        },
        PacketSpec {
            label: "no route configured".to_string(),
            destination: "missing".to_string(),
            amount: 0,
            expires_in_seconds: 300,
            execution_condition_hex: condition_hex_for_fulfillment(&FULFILLMENT),
            data: "irrelevant".to_string(),
        },
    ]
}

#[tokio::test]
async fn identical_fleets_under_different_prefixes_and_ports_show_no_divergence() {
    let stub_app_a = spawn_stub_app();
    let stub_app_b = spawn_stub_app();
    let dead_a = dead_addr();
    let dead_b = dead_addr();

    let key_a = write_raw_key_file(1);
    let config_a = write_config(&connector_config(
        key_a.path(),
        "g.fleet-a",
        Some(&stub_app_a.addr),
        &dead_a,
    ));
    let connector_a = spawn_connector(config_a.path());

    let key_b = write_raw_key_file(2);
    let config_b = write_config(&connector_config(
        key_b.path(),
        "g.fleet-b",
        Some(&stub_app_b.addr),
        &dead_b,
    ));
    let connector_b = spawn_connector(config_b.path());

    let fleet_a = FleetTarget {
        client_edge_url: format!("http://{}", connector_a.client_edge_addr),
        prefix: "g.fleet-a".to_string(),
    };
    let fleet_b = FleetTarget {
        client_edge_url: format!("http://{}", connector_b.client_edge_addr),
        prefix: "g.fleet-b".to_string(),
    };

    let client = reqwest::Client::new();
    let packets = packet_sequence();
    let outcomes_a = run_sequence(&client, &fleet_a, &packets).await;
    let outcomes_b = run_sequence(&client, &fleet_b, &packets).await;
    let comparisons = compare(&packets, &fleet_a, &outcomes_a, &fleet_b, &outcomes_b);

    assert!(
        !any_diverged(&comparisons),
        "two identically-configured fleets, differing only in port and \
         prefix, must not report a divergence:\n{}",
        render_report(&comparisons)
    );
}

#[tokio::test]
async fn a_deliberately_introduced_difference_is_reported() {
    let stub_app_a = spawn_stub_app();
    let dead_a = dead_addr();
    let dead_b = dead_addr();

    let key_a = write_raw_key_file(3);
    let config_a = write_config(&connector_config(
        key_a.path(),
        "g.fleet-a",
        Some(&stub_app_a.addr),
        &dead_a,
    ));
    let connector_a = spawn_connector(config_a.path());

    // Fleet B's deliberate divergence: no route for `.app` at all -- e.g.
    // a config that regressed or was never rolled out, exactly the kind
    // of real behavioral difference a control comparison must catch
    // before a migration, not after one.
    let key_b = write_raw_key_file(4);
    let config_b = write_config(&connector_config(key_b.path(), "g.fleet-b", None, &dead_b));
    let connector_b = spawn_connector(config_b.path());

    let fleet_a = FleetTarget {
        client_edge_url: format!("http://{}", connector_a.client_edge_addr),
        prefix: "g.fleet-a".to_string(),
    };
    let fleet_b = FleetTarget {
        client_edge_url: format!("http://{}", connector_b.client_edge_addr),
        prefix: "g.fleet-b".to_string(),
    };

    let client = reqwest::Client::new();
    let packets = packet_sequence();
    let outcomes_a = run_sequence(&client, &fleet_a, &packets).await;
    let outcomes_b = run_sequence(&client, &fleet_b, &packets).await;
    let comparisons = compare(&packets, &fleet_a, &outcomes_a, &fleet_b, &outcomes_b);

    assert!(
        any_diverged(&comparisons),
        "fleet B's missing '.app' route is a real divergence and must be caught"
    );

    let report = render_report(&comparisons);
    assert!(report.contains("[DIVERGED]"), "report:\n{report}");

    let fulfils = comparisons
        .iter()
        .find(|comparison| comparison.label == "fulfils")
        .expect("a comparison for the 'fulfils' packet");
    assert!(
        fulfils.diverged,
        "fleet A fulfils '.app' and fleet B has no route for it at all -- \
         this must diverge"
    );
    assert!(
        fulfils.fleet_a.starts_with("FULFILL"),
        "{}",
        fulfils.fleet_a
    );
    assert!(fulfils.fleet_b.starts_with("REJECT"), "{}", fulfils.fleet_b);

    // Untouched by the deliberate divergence: both fleets still have a
    // `.down` route (dead app either side -> T01, normalized the same)
    // and neither has a route for `missing` at all (-> F02, normalized
    // the same) -- precision, not just "everything looks different now".
    for label in ["app unreachable", "no route configured"] {
        let comparison = comparisons
            .iter()
            .find(|comparison| comparison.label == label)
            .unwrap_or_else(|| panic!("a comparison for '{label}'"));
        assert!(
            !comparison.diverged,
            "'{label}' was not touched by the deliberate divergence and \
             must still match:\n{}",
            render_report(&comparisons)
        );
    }
}
