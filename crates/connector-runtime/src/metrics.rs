//! The decided metrics surface (ADR 0014): packets, rejects, fees, exposure
//! and settlement, gathered on a per-[`crate::Connector`] Prometheus
//! [`Registry`] and exposed read-only through the operator surface
//! (`GET /metrics`, bearer-token gated per ADR 0008 -- metrics are a read
//! like peers or routes, not a separate unauthenticated port).
//!
//! `exposure` and `settlement` are declared now but always report zero:
//! nothing in the runtime tracks either yet (issues #422-#424), matching the
//! precedent [`crate::operator_view`]'s empty `ExposureView`/`ChannelView`
//! already set -- the shape is complete so those tickets only need to start
//! populating it.

use prometheus::{Encoder, IntCounter, IntCounterVec, IntGauge, Opts, Registry, TextEncoder};

/// A [`crate::Connector`]'s own metrics. One instance per `Connector`,
/// created internally rather than injected -- there is exactly one sensible
/// implementation (a Prometheus registry), so this is a field, not a port.
pub struct Metrics {
    registry: Registry,
    packets_total: IntCounterVec,
    packets_rejected_total: IntCounterVec,
    fees_earned_total: IntCounter,
}

impl Metrics {
    pub fn new() -> Metrics {
        let registry = Registry::new();

        let packets_total = IntCounterVec::new(
            Opts::new(
                "toon_packets_total",
                "Count of packets handled by this connector, by outcome.",
            ),
            &["outcome"],
        )
        .expect("valid metric");
        let packets_rejected_total = IntCounterVec::new(
            Opts::new(
                "toon_packets_rejected_total",
                "Count of rejected packets, by RFC-0027 reject code.",
            ),
            &["code"],
        )
        .expect("valid metric");
        let fees_earned_total = IntCounter::new(
            "toon_fees_earned_total",
            "Total flat per-packet fees earned across every peering relation (ADR 0010), counted on fulfilment.",
        )
        .expect("valid metric");
        let exposure = IntGauge::new(
            "toon_exposure",
            "Unclaimed exposure to peers. Always 0 until the claim/exposure projection lands (issues #423, #424).",
        )
        .expect("valid metric");
        let settlement_total = IntCounter::new(
            "toon_settlement_total",
            "Count of on-chain settlements performed. Always 0 until channel lifecycle and claim redemption land (issue #422).",
        )
        .expect("valid metric");

        registry
            .register(Box::new(packets_total.clone()))
            .expect("register metric");
        registry
            .register(Box::new(packets_rejected_total.clone()))
            .expect("register metric");
        registry
            .register(Box::new(fees_earned_total.clone()))
            .expect("register metric");
        // `exposure` and `settlement_total` have no producer yet (issues
        // #422-#424): registered so the metric is present at its decided
        // name and stays at 0, with no field kept for a value nothing
        // updates.
        registry
            .register(Box::new(exposure))
            .expect("register metric");
        registry
            .register(Box::new(settlement_total))
            .expect("register metric");

        Metrics {
            registry,
            packets_total,
            packets_rejected_total,
            fees_earned_total,
        }
    }

    pub(crate) fn record_fulfill(&self) {
        self.packets_total.with_label_values(&["fulfill"]).inc();
    }

    pub(crate) fn record_reject(&self, code: &str) {
        self.packets_total.with_label_values(&["reject"]).inc();
        self.packets_rejected_total.with_label_values(&[code]).inc();
    }

    pub(crate) fn record_fee_earned(&self, amount: u64) {
        self.fees_earned_total.inc_by(amount);
    }

    /// Render every metric in Prometheus text exposition format.
    pub fn encode(&self) -> String {
        let families = self.registry.gather();
        let mut buf = Vec::new();
        TextEncoder::new()
            .encode(&families, &mut buf)
            .expect("encode metrics");
        String::from_utf8(buf).expect("metrics text is valid utf-8")
    }
}

impl Default for Metrics {
    fn default() -> Metrics {
        Metrics::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_a_fulfill() {
        let metrics = Metrics::new();
        metrics.record_fulfill();
        let text = metrics.encode();
        assert!(text.contains(r#"toon_packets_total{outcome="fulfill"} 1"#));
    }

    #[test]
    fn records_a_reject_by_code() {
        let metrics = Metrics::new();
        metrics.record_reject("F02");
        let text = metrics.encode();
        assert!(text.contains(r#"toon_packets_total{outcome="reject"} 1"#));
        assert!(text.contains(r#"toon_packets_rejected_total{code="F02"} 1"#));
    }

    #[test]
    fn records_fees_earned() {
        let metrics = Metrics::new();
        metrics.record_fee_earned(7);
        metrics.record_fee_earned(3);
        let text = metrics.encode();
        assert!(text.contains("toon_fees_earned_total 10"));
    }

    #[test]
    fn exposure_and_settlement_report_zero_until_their_tickets_land() {
        let metrics = Metrics::new();
        let text = metrics.encode();
        assert!(text.contains("toon_exposure 0"));
        assert!(text.contains("toon_settlement_total 0"));
    }
}
