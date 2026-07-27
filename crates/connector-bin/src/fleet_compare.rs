//! Side-by-side comparison harness for two fleets (issue #491, parent
//! #431, ADR 0013): drives the same ordered sequence of PREPAREs at each
//! fleet's client edge and reports where their outcomes diverge.
//!
//! ADR 0013 keeps the old TypeScript fleet running specifically so it can
//! serve as "a control for comparing behaviour under identical conditions
//! rather than against memory" -- this module is that comparison, built and
//! proven (`tests/fleet_compare_two_local_fleets.rs`) before any cutover,
//! not during one.
//!
//! ## What is normalized, and why
//!
//! Two fleets under test necessarily differ in ways that carry no
//! behavioral meaning, and an over-eager normalizer that hides a *real*
//! divergence is worse than no harness at all -- so only exactly these are
//! folded away, each for a stated reason:
//!
//! 1. **Socket addresses** (`ipv4:port`) inside reject/error text. A local
//!    proof run binds both fleets to OS-assigned ports on `127.0.0.1`; a
//!    devnet run addresses apps by prefix instead. Either way, *which*
//!    port or host an app happens to be reachable at is not ILP-level
//!    behavior -- it only leaks into a `T01` reject's `message` because
//!    the underlying HTTP client's error `Display` embeds the URL it
//!    tried (`connector_runtime::app_client::HttpAppClient::deliver`).
//!    Only the dotted-quad IPv4 form is recognized ([`scrub_addresses`]);
//!    a devnet host addressed by name would need this extending, which is
//!    flagged here rather than silently assumed away.
//! 2. **Each fleet's own configured prefix**, wherever it is echoed back
//!    (e.g. an `F02` "no route to destination '<dest>'" message embeds
//!    the full destination, prefix included). ADR 0013's whole point is
//!    that the two fleets run under *different* prefixes, so the prefix
//!    string itself can never be a behavioral difference -- each side's
//!    outcome is normalized against its own [`FleetTarget::prefix`] before
//!    the two are compared.
//! 3. **Latency.** Measured (per packet, per fleet) for the human-readable
//!    report, but never enters the equality check -- nothing about
//!    wall-clock timing is a claim about behavior.
//! 4. **Response ordering** needs no normalization because nothing can put
//!    it at risk: [`run_sequence`] sends one packet at a time and awaits
//!    the reply before sending the next, against both fleets, so packet
//!    `i`'s outcome on fleet A is always compared against packet `i`'s
//!    outcome on fleet B by construction, not by sorting or matching them
//!    up after the fact.
//!
//! Everything else -- the reject code, `accumulated_fee`, the fulfilled
//! preimage, the HTTP status, and the app-level `data` payload once
//! addresses are scrubbed out of it -- is compared exactly. Those are
//! precisely the fields a real behavioral divergence would show up in, so
//! nothing here touches them.
//!
//! `accumulated_fee` is always `0` as observed through this harness: the
//! client edge does not yet expose peer-wire fee accumulation over HTTP
//! (`docs/protocol/client-edge-spec.md` §1.6 is explicitly forward-looking
//! -- no `TOON-Accumulated-Fee` response header exists yet), so this
//! harness compares whatever the wire currently carries, not more than
//! that.

use std::time::{Duration, Instant};

use chrono::{Duration as ChronoDuration, Utc};
use connector_domain::{derive_condition, Fulfill, Prepare, Reject};
use serde::Deserialize;

/// One fleet to drive packets at: its client edge's base URL (e.g.
/// `http://127.0.0.1:54321` for a locally-spawned fleet, or a devnet
/// gateway's URL) and the ILP address prefix its routes are configured
/// under.
#[derive(Debug, Clone)]
pub struct FleetTarget {
    pub client_edge_url: String,
    pub prefix: String,
}

/// One packet in the sequence driven at both fleets. `destination` is
/// relative to each fleet's own [`FleetTarget::prefix`] -- the same spec
/// therefore addresses two different, but structurally equivalent, ILP
/// addresses on the two fleets, which is exactly what "pointable at two
/// devnet prefixes without code changes" requires: only the two
/// [`FleetTarget`]s change, never the packet sequence.
#[derive(Debug, Clone, Deserialize)]
pub struct PacketSpec {
    pub label: String,
    pub destination: String,
    #[serde(default)]
    pub amount: u64,
    #[serde(default = "default_expires_in_seconds")]
    pub expires_in_seconds: i64,
    pub execution_condition_hex: String,
    #[serde(default)]
    pub data: String,
}

fn default_expires_in_seconds() -> i64 {
    300
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_hex_32(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Hex-encode the execution condition RFC-0022 derives from a given
/// fulfillment preimage, so a [`PacketSpec`] (hand-written JSON, or built
/// directly by a test) can be authored in terms of "what fulfillment do I
/// expect" rather than a precomputed hash.
pub fn condition_hex_for_fulfillment(fulfillment: &[u8; 32]) -> String {
    hex_encode(&derive_condition(fulfillment))
}

impl PacketSpec {
    fn to_prepare(&self, prefix: &str) -> Prepare {
        let condition = decode_hex_32(&self.execution_condition_hex).unwrap_or_else(|| {
            panic!(
                "packet '{}': execution_condition_hex must be 64 hex characters, got '{}'",
                self.label, self.execution_condition_hex
            )
        });
        Prepare {
            amount: self.amount,
            expires_at: Utc::now() + ChronoDuration::seconds(self.expires_in_seconds),
            execution_condition: condition,
            destination: format!("{prefix}.{}", self.destination),
            data: self.data.clone().into_bytes(),
        }
    }
}

/// What driving one [`PacketSpec`] at one [`FleetTarget`] produced. Kept
/// close to the wire (raw `Vec<u8>`/`String` payloads) -- normalization
/// happens later, exactly once, in [`Outcome::normalized`], so there is
/// exactly one place that decides what does and doesn't count as
/// incidental.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Fulfill {
        fulfillment: [u8; 32],
        data: Vec<u8>,
    },
    Reject {
        code: String,
        message: String,
        data: Vec<u8>,
        accumulated_fee: u64,
    },
    /// The client edge answered, but not with HTTP 200 (e.g. a malformed
    /// PREPARE rejected at `400` before it was ever routed).
    HttpError { status: u16, body: String },
    /// A `200` response whose body was neither a valid FULFILL nor a
    /// valid REJECT.
    Malformed { detail: String },
    /// The HTTP request to the fleet's client edge itself never
    /// completed (connection refused, timed out, DNS failure, ...).
    RequestFailed { detail: String },
}

/// If `chars` begins with an IPv4 socket address (`ddd.ddd.ddd.ddd:ddddd`),
/// how many `char`s it spans -- otherwise `None`.
fn socket_addr_len(chars: &[char]) -> Option<usize> {
    let mut idx = 0;
    for group in 0..4 {
        let start = idx;
        while idx < chars.len() && chars[idx].is_ascii_digit() {
            idx += 1;
        }
        if idx == start || idx - start > 3 {
            return None;
        }
        if group < 3 {
            if chars.get(idx) != Some(&'.') {
                return None;
            }
            idx += 1;
        }
    }
    if chars.get(idx) != Some(&':') {
        return None;
    }
    idx += 1;
    let port_start = idx;
    while idx < chars.len() && chars[idx].is_ascii_digit() {
        idx += 1;
    }
    if idx == port_start {
        return None;
    }
    Some(idx)
}

/// Replace every IPv4 `host:port` substring with `<ADDR>` -- see the
/// module doc's point 1 for why this, and only this, address form is
/// recognized.
fn scrub_addresses(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        match socket_addr_len(&chars[i..]) {
            Some(len) => {
                out.push_str("<ADDR>");
                i += len;
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

/// Replace every occurrence of this fleet's own prefix with `<PREFIX>` --
/// see the module doc's point 2.
fn scrub_prefix(text: &str, prefix: &str) -> String {
    if prefix.is_empty() {
        text.to_string()
    } else {
        text.replace(prefix, "<PREFIX>")
    }
}

fn normalize_text(text: &str, prefix: &str) -> String {
    scrub_prefix(&scrub_addresses(text), prefix)
}

impl Outcome {
    /// Fold away exactly the incidental differences documented on this
    /// module -- see there for what and why. The result is a single
    /// string, so comparing two [`Outcome`]s (each normalized against its
    /// own fleet's prefix) is one `==`.
    fn normalized(&self, prefix: &str) -> String {
        match self {
            Outcome::Fulfill { fulfillment, data } => format!(
                "FULFILL fulfillment={} data={}",
                hex_encode(fulfillment),
                normalize_text(&String::from_utf8_lossy(data), prefix),
            ),
            Outcome::Reject {
                code,
                message,
                data,
                accumulated_fee,
            } => format!(
                "REJECT code={code} accumulated_fee={accumulated_fee} message={} data={}",
                normalize_text(message, prefix),
                normalize_text(&String::from_utf8_lossy(data), prefix),
            ),
            Outcome::HttpError { status, body } => format!(
                "HTTP_ERROR status={status} body={}",
                normalize_text(body, prefix)
            ),
            Outcome::Malformed { detail } => {
                format!("MALFORMED {}", normalize_text(detail, prefix))
            }
            Outcome::RequestFailed { detail } => {
                format!("REQUEST_FAILED {}", normalize_text(detail, prefix))
            }
        }
    }
}

/// Send one packet to one fleet and classify the response. Never panics on
/// a network or protocol-level failure -- those become outcomes
/// ([`Outcome::RequestFailed`], [`Outcome::Malformed`]) to be compared
/// like any other, since one fleet failing differently from its
/// counterpart is exactly the kind of divergence this harness exists to
/// catch.
pub async fn send_packet(
    client: &reqwest::Client,
    fleet: &FleetTarget,
    packet: &PacketSpec,
) -> Outcome {
    let prepare = packet.to_prepare(&fleet.prefix);
    let url = format!("{}/ilp", fleet.client_edge_url.trim_end_matches('/'));

    let response = match client.post(&url).body(prepare.encode()).send().await {
        Ok(response) => response,
        Err(source) => {
            return Outcome::RequestFailed {
                detail: source.to_string(),
            }
        }
    };
    let status = response.status();
    let body = match response.bytes().await {
        Ok(body) => body,
        Err(source) => {
            return Outcome::RequestFailed {
                detail: source.to_string(),
            }
        }
    };
    if !status.is_success() {
        return Outcome::HttpError {
            status: status.as_u16(),
            body: String::from_utf8_lossy(&body).into_owned(),
        };
    }
    if let Ok(fulfill) = Fulfill::decode(&body) {
        return Outcome::Fulfill {
            fulfillment: fulfill.fulfillment,
            data: fulfill.data,
        };
    }
    match Reject::decode(&body) {
        Ok(reject) => Outcome::Reject {
            code: reject.code.as_str().to_string(),
            message: reject.message,
            data: reject.data,
            accumulated_fee: reject.accumulated_fee,
        },
        Err(source) => Outcome::Malformed {
            detail: source.to_string(),
        },
    }
}

/// Drive `packets` at `fleet`, one at a time, in order -- awaiting each
/// reply before sending the next (module doc point 4: this is why
/// response ordering needs no separate normalization). Returns each
/// outcome alongside how long the round trip took, for the report only.
pub async fn run_sequence(
    client: &reqwest::Client,
    fleet: &FleetTarget,
    packets: &[PacketSpec],
) -> Vec<(Outcome, Duration)> {
    let mut outcomes = Vec::with_capacity(packets.len());
    for packet in packets {
        let started = Instant::now();
        let outcome = send_packet(client, fleet, packet).await;
        outcomes.push((outcome, started.elapsed()));
    }
    outcomes
}

/// The comparison for one packet, once both fleets have answered.
#[derive(Debug, Clone)]
pub struct PacketComparison {
    pub label: String,
    pub diverged: bool,
    pub fleet_a: String,
    pub fleet_b: String,
    pub duration_a: Duration,
    pub duration_b: Duration,
}

/// Compare two fleets' answers to the same packet sequence. `packets`,
/// `outcomes_a` and `outcomes_b` must be the same length and in the same
/// order -- exactly what [`run_sequence`] produces for the same `packets`
/// slice run against each fleet.
pub fn compare(
    packets: &[PacketSpec],
    fleet_a: &FleetTarget,
    outcomes_a: &[(Outcome, Duration)],
    fleet_b: &FleetTarget,
    outcomes_b: &[(Outcome, Duration)],
) -> Vec<PacketComparison> {
    assert_eq!(
        packets.len(),
        outcomes_a.len(),
        "packets and fleet A outcomes must line up 1:1"
    );
    assert_eq!(
        packets.len(),
        outcomes_b.len(),
        "packets and fleet B outcomes must line up 1:1"
    );

    packets
        .iter()
        .zip(outcomes_a.iter())
        .zip(outcomes_b.iter())
        .map(
            |((packet, (outcome_a, duration_a)), (outcome_b, duration_b))| {
                let normalized_a = outcome_a.normalized(&fleet_a.prefix);
                let normalized_b = outcome_b.normalized(&fleet_b.prefix);
                PacketComparison {
                    label: packet.label.clone(),
                    diverged: normalized_a != normalized_b,
                    fleet_a: normalized_a,
                    fleet_b: normalized_b,
                    duration_a: *duration_a,
                    duration_b: *duration_b,
                }
            },
        )
        .collect()
}

/// Whether any packet in the comparison diverged -- the signal a caller
/// (the CLI, or CI) uses to decide whether to fail.
pub fn any_diverged(comparisons: &[PacketComparison]) -> bool {
    comparisons.iter().any(|comparison| comparison.diverged)
}

/// Render a human-readable report. "A human deciding whether to proceed
/// with a migration" is this function's actual audience (the issue's own
/// acceptance criterion), so it says plainly what matched, what diverged
/// and how long each side took -- and, for a divergence, shows both
/// normalized outcomes side by side rather than just flagging that they
/// differ.
pub fn render_report(comparisons: &[PacketComparison]) -> String {
    let mut out = String::new();
    for comparison in comparisons {
        if comparison.diverged {
            out.push_str(&format!(
                "[DIVERGED] {} (fleet A: {:?}, fleet B: {:?})\n  fleet A: {}\n  fleet B: {}\n",
                comparison.label,
                comparison.duration_a,
                comparison.duration_b,
                comparison.fleet_a,
                comparison.fleet_b,
            ));
        } else {
            out.push_str(&format!(
                "[match]    {} (fleet A: {:?}, fleet B: {:?})\n",
                comparison.label, comparison.duration_a, comparison.duration_b,
            ));
        }
    }
    let diverged_count = comparisons.iter().filter(|c| c.diverged).count();
    out.push_str(&format!(
        "\n{diverged_count} of {} packet(s) diverged.\n",
        comparisons.len()
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_fulfils_normalize_to_the_same_string_on_different_prefixes() {
        let a = Outcome::Fulfill {
            fulfillment: [7u8; 32],
            data: b"delivered by stub app: hello".to_vec(),
        };
        let b = a.clone();
        assert_eq!(a.normalized("g.fleet-a"), b.normalized("g.fleet-b"));
    }

    #[test]
    fn a_no_route_reject_normalizes_the_same_across_two_different_prefixes() {
        let a = Outcome::Reject {
            code: "F02".to_string(),
            message: "no route to destination 'g.fleet-a.missing'".to_string(),
            data: Vec::new(),
            accumulated_fee: 0,
        };
        let b = Outcome::Reject {
            code: "F02".to_string(),
            message: "no route to destination 'g.fleet-b.missing'".to_string(),
            data: Vec::new(),
            accumulated_fee: 0,
        };
        assert_eq!(a.normalized("g.fleet-a"), b.normalized("g.fleet-b"));
    }

    #[test]
    fn an_unreachable_app_reject_normalizes_the_same_across_two_different_ports() {
        let a = Outcome::Reject {
            code: "T01".to_string(),
            message: "error sending request for url (http://127.0.0.1:54321/): connection refused"
                .to_string(),
            data: Vec::new(),
            accumulated_fee: 0,
        };
        let b = Outcome::Reject {
            code: "T01".to_string(),
            message: "error sending request for url (http://127.0.0.1:9999/): connection refused"
                .to_string(),
            data: Vec::new(),
            accumulated_fee: 0,
        };
        assert_eq!(a.normalized("g.fleet"), b.normalized("g.fleet"));
    }

    #[test]
    fn a_genuinely_different_reject_code_is_not_normalized_away() {
        let a = Outcome::Reject {
            code: "F99".to_string(),
            message: "app declined the delivery with HTTP 402".to_string(),
            data: Vec::new(),
            accumulated_fee: 0,
        };
        let b = Outcome::Reject {
            code: "F02".to_string(),
            message: "no route to destination 'g.fleet.app'".to_string(),
            data: Vec::new(),
            accumulated_fee: 0,
        };
        assert_ne!(a.normalized("g.fleet"), b.normalized("g.fleet"));
    }

    #[test]
    fn a_fulfil_and_a_reject_for_the_same_packet_are_never_equal() {
        let fulfil = Outcome::Fulfill {
            fulfillment: [7u8; 32],
            data: b"delivered".to_vec(),
        };
        let reject = Outcome::Reject {
            code: "F02".to_string(),
            message: "no route to destination 'g.fleet.app'".to_string(),
            data: Vec::new(),
            accumulated_fee: 0,
        };
        assert_ne!(fulfil.normalized("g.fleet"), reject.normalized("g.fleet"));
    }

    #[test]
    fn compare_reports_no_divergence_for_two_identical_fleets() {
        let packet = PacketSpec {
            label: "fulfil".to_string(),
            destination: "app".to_string(),
            amount: 0,
            expires_in_seconds: 300,
            execution_condition_hex: condition_hex_for_fulfillment(&[7u8; 32]),
            data: "hello".to_string(),
        };
        let fleet_a = FleetTarget {
            client_edge_url: "http://127.0.0.1:1".to_string(),
            prefix: "g.fleet-a".to_string(),
        };
        let fleet_b = FleetTarget {
            client_edge_url: "http://127.0.0.1:2".to_string(),
            prefix: "g.fleet-b".to_string(),
        };
        let fulfil = || {
            (
                Outcome::Fulfill {
                    fulfillment: [7u8; 32],
                    data: b"delivered by stub app: hello".to_vec(),
                },
                Duration::from_millis(1),
            )
        };

        let comparisons = compare(&[packet], &fleet_a, &[fulfil()], &fleet_b, &[fulfil()]);

        assert!(!any_diverged(&comparisons));
        assert!(render_report(&comparisons).contains("0 of 1 packet(s) diverged"));
    }

    #[test]
    fn compare_reports_a_real_divergence() {
        let packet = PacketSpec {
            label: "fulfil".to_string(),
            destination: "app".to_string(),
            amount: 0,
            expires_in_seconds: 300,
            execution_condition_hex: condition_hex_for_fulfillment(&[7u8; 32]),
            data: "hello".to_string(),
        };
        let fleet_a = FleetTarget {
            client_edge_url: "http://127.0.0.1:1".to_string(),
            prefix: "g.fleet-a".to_string(),
        };
        let fleet_b = FleetTarget {
            client_edge_url: "http://127.0.0.1:2".to_string(),
            prefix: "g.fleet-b".to_string(),
        };
        let outcome_a = (
            Outcome::Fulfill {
                fulfillment: [7u8; 32],
                data: b"delivered by stub app: hello".to_vec(),
            },
            Duration::from_millis(1),
        );
        let outcome_b = (
            Outcome::Reject {
                code: "F02".to_string(),
                message: "no route to destination 'g.fleet-b.app'".to_string(),
                data: Vec::new(),
                accumulated_fee: 0,
            },
            Duration::from_millis(1),
        );

        let comparisons = compare(&[packet], &fleet_a, &[outcome_a], &fleet_b, &[outcome_b]);

        assert!(any_diverged(&comparisons));
        let report = render_report(&comparisons);
        assert!(report.contains("[DIVERGED]"));
        assert!(report.contains("1 of 1 packet(s) diverged"));
    }
}
