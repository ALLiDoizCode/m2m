//! Flat per-packet fee arithmetic
//! ([ADR 0010](../../../docs/adr/0010-flat-per-packet-fee-and-minimum-delivery.md)):
//! what a hop earns forwarding one packet. The fee is a flat amount
//! subtracted once per packet, never a share of `amount` -- there is no
//! percentage or basis-point arithmetic anywhere in this module, which is
//! what keeps a packet of any size charged rather than rounding to zero.
//!
//! What bounds erosion across a path is not arithmetic here but the claim
//! covering each crossing: `cover_forward` mints for the packet's forwarded
//! value, so every hop holds a claim for at least what it passes on (ADR
//! 0057, issue #1143). There is no declared floor for this module to check.

/// The amount this hop forwards downstream once its own flat `fee` (agreed
/// bilaterally for the peering relation, per ADR 0010) is taken from
/// `amount`, or `None` if the fee alone exceeds what arrived.
pub fn amount_after_fee(amount: u64, fee: u64) -> Option<u64> {
    amount.checked_sub(fee)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn subtracts_the_flat_fee() {
        assert_eq!(amount_after_fee(100, 5), Some(95));
    }

    #[test]
    fn rejects_when_the_fee_alone_exceeds_the_amount() {
        assert_eq!(amount_after_fee(3, 5), None);
    }

    #[test]
    fn a_tiny_packet_is_still_charged_the_full_flat_fee() {
        // Regression for the basis-point model this replaces (ADR 0010),
        // where a packet under 1000 units at the default rate was carried
        // for free because amount / 1000 rounded down to zero.
        assert_eq!(amount_after_fee(1, 1), Some(0));
        assert_eq!(amount_after_fee(1, 2), None);
    }

    #[test]
    fn zero_fee_forwards_the_full_amount() {
        assert_eq!(amount_after_fee(42, 0), Some(42));
    }

    proptest! {
        #[test]
        fn never_forwards_more_than_was_received(
            amount in any::<u64>(),
            fee in any::<u64>(),
        ) {
            if let Some(forwarded) = amount_after_fee(amount, fee) {
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
            if let Some(forwarded) = amount_after_fee(amount, fee) {
                prop_assert_eq!(amount - forwarded, fee);
            }
        }
    }
}
