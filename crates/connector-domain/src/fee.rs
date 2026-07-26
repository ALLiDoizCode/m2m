//! Flat per-packet fee and minimum-delivery arithmetic
//! ([ADR 0010](../../../docs/adr/0010-flat-per-packet-fee-and-minimum-delivery.md)):
//! what a hop earns forwarding one packet, and the sender's guarantee about
//! what reaches the destination. The fee is a flat amount subtracted once
//! per packet, never a share of `amount` -- there is no percentage or
//! basis-point arithmetic anywhere in this module, which is what keeps a
//! packet of any size charged rather than rounding to zero.

/// The amount this hop forwards downstream once its own flat `fee` (agreed
/// bilaterally for the peering relation, per ADR 0010) is taken from
/// `amount`, or `None` if that would forward less than `minimum_delivery`
/// -- the amount the original sender declared must reach the destination.
///
/// A hop that gets `None` here must reject
/// ([`crate::RejectCode::r01_insufficient_source_amount`]) rather than
/// forward a smaller amount and hope a downstream hop makes up the
/// difference: no downstream hop ever increases an amount, so the
/// shortfall would only grow.
pub fn amount_after_fee(amount: u64, fee: u64, minimum_delivery: u64) -> Option<u64> {
    let forwarded = amount.checked_sub(fee)?;
    (forwarded >= minimum_delivery).then_some(forwarded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn subtracts_the_flat_fee() {
        assert_eq!(amount_after_fee(100, 5, 0), Some(95));
    }

    #[test]
    fn rejects_when_the_fee_alone_exceeds_the_amount() {
        assert_eq!(amount_after_fee(3, 5, 0), None);
    }

    #[test]
    fn rejects_when_forwarding_would_fall_below_the_minimum() {
        assert_eq!(amount_after_fee(100, 10, 95), None);
    }

    #[test]
    fn forwards_exactly_at_the_declared_minimum() {
        assert_eq!(amount_after_fee(100, 10, 90), Some(90));
    }

    #[test]
    fn a_tiny_packet_is_still_charged_the_full_flat_fee() {
        // Regression for the basis-point model this replaces (ADR 0010),
        // where a packet under 1000 units at the default rate was carried
        // for free because amount / 1000 rounded down to zero.
        assert_eq!(amount_after_fee(1, 1, 0), Some(0));
        assert_eq!(amount_after_fee(1, 2, 0), None);
    }

    #[test]
    fn zero_fee_forwards_the_full_amount() {
        assert_eq!(amount_after_fee(42, 0, 42), Some(42));
    }

    proptest! {
        #[test]
        fn never_forwards_below_the_declared_minimum(
            amount in any::<u64>(),
            fee in any::<u64>(),
            minimum_delivery in any::<u64>(),
        ) {
            if let Some(forwarded) = amount_after_fee(amount, fee, minimum_delivery) {
                prop_assert!(forwarded >= minimum_delivery);
            }
        }

        #[test]
        fn never_forwards_more_than_was_received(
            amount in any::<u64>(),
            fee in any::<u64>(),
            minimum_delivery in any::<u64>(),
        ) {
            if let Some(forwarded) = amount_after_fee(amount, fee, minimum_delivery) {
                prop_assert!(forwarded <= amount);
            }
        }

        #[test]
        fn the_fee_actually_taken_is_always_the_exact_configured_fee(
            amount in any::<u64>(),
            fee in any::<u64>(),
        ) {
            // No rounding, no percentage: whenever a fee can be taken at
            // all, it is taken in full.
            if let Some(forwarded) = amount_after_fee(amount, fee, 0) {
                prop_assert_eq!(amount - forwarded, fee);
            }
        }
    }
}
