//! Execution condition, fulfilment and expiry (RFC-0022) -- pure, no I/O.
//!
//! Trustless forwarding rests on one property: a hop is paid only against a
//! preimage it cannot forge. That means every packet needs a real,
//! sender-chosen condition (a missing or all-zero one is invalid, never a
//! legacy "no condition" case), and a fulfilment is only ever accepted once
//! its preimage is checked against that condition. There is deliberately no
//! function anywhere in this module that goes the other way -- from a
//! condition to a fulfilment -- since that is exactly the derived-preimage
//! hole issue #417 closes.

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

/// RFC-0027's wire format has no separate "absent" representation for
/// `executionCondition` -- all-zero is the only way "no condition" can be
/// expressed. This connector treats that state as invalid outright rather
/// than as a legacy auto-fulfill path, so every packet must carry a real
/// condition to be eligible for forwarding at all.
pub fn condition_is_present(condition: &[u8; 32]) -> bool {
    *condition != [0u8; 32]
}

/// The condition a `fulfillment` satisfies: `sha256(fulfillment)`. Hashing
/// only ever runs in this direction -- from a chosen preimage to the
/// condition it produces -- never reversed.
pub fn derive_condition(fulfillment: &[u8; 32]) -> [u8; 32] {
    Sha256::digest(fulfillment).into()
}

/// Whether `fulfillment` is the real preimage of `condition`:
/// `sha256(fulfillment) == condition`. This is the one check that gives an
/// execution condition economic force -- a hop is paid only when it holds a
/// preimage that verifies, never on a downstream peer's or app's word alone.
pub fn fulfillment_matches_condition(condition: &[u8; 32], fulfillment: &[u8; 32]) -> bool {
    derive_condition(fulfillment) == *condition
}

/// Whether a packet due to expire at `expires_at` is expired as of `now`.
/// `now == expires_at` counts as expired: a packet must fulfil strictly
/// before its deadline, not up to and including it.
pub fn is_expired(expires_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    now >= expires_at
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone};
    use proptest::prelude::*;

    fn at(y: i32, m: u32, d: u32, hh: u32, mm: u32, ss: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, hh, mm, ss).unwrap()
    }

    #[test]
    fn an_all_zero_condition_is_not_present() {
        assert!(!condition_is_present(&[0u8; 32]));
    }

    #[test]
    fn a_single_nonzero_byte_makes_a_condition_present() {
        let mut condition = [0u8; 32];
        condition[31] = 1;
        assert!(condition_is_present(&condition));
    }

    #[test]
    fn the_real_preimage_matches_the_condition_it_derives() {
        let fulfillment = [7u8; 32];
        let condition = derive_condition(&fulfillment);
        assert!(fulfillment_matches_condition(&condition, &fulfillment));
    }

    #[test]
    fn a_different_preimage_does_not_match() {
        let condition = derive_condition(&[7u8; 32]);
        assert!(!fulfillment_matches_condition(&condition, &[9u8; 32]));
    }

    #[test]
    fn a_packet_at_exactly_its_expiry_is_expired() {
        let deadline = at(2030, 1, 1, 0, 0, 0);
        assert!(is_expired(deadline, deadline));
    }

    #[test]
    fn a_packet_a_second_before_its_expiry_is_not_expired() {
        let expires_at = at(2030, 1, 1, 0, 0, 1);
        let now = at(2030, 1, 1, 0, 0, 0);
        assert!(!is_expired(expires_at, now));
    }

    #[test]
    fn a_packet_a_second_past_its_expiry_is_expired() {
        let expires_at = at(2030, 1, 1, 0, 0, 0);
        let now = expires_at + Duration::seconds(1);
        assert!(is_expired(expires_at, now));
    }

    proptest! {
        /// Only the exact preimage a condition was derived from ever matches
        /// it -- a claimed fulfilment cannot be forged by picking any other
        /// 32 bytes.
        #[test]
        fn only_the_derived_preimage_matches_its_condition(
            fulfillment in proptest::array::uniform32(any::<u8>()),
            other in proptest::array::uniform32(any::<u8>()),
        ) {
            let condition = derive_condition(&fulfillment);
            prop_assert!(fulfillment_matches_condition(&condition, &fulfillment));
            if other != fulfillment {
                prop_assert!(!fulfillment_matches_condition(&condition, &other));
            }
        }

        /// Presence is exactly "not all-zero", for every possible condition.
        #[test]
        fn presence_matches_the_all_zero_definition(
            condition in proptest::array::uniform32(any::<u8>())
        ) {
            prop_assert_eq!(condition_is_present(&condition), condition != [0u8; 32]);
        }

        /// Expiry is a total order on the offset between `now` and
        /// `expires_at`: expired for every non-negative offset, not expired
        /// for every negative one.
        #[test]
        fn expiry_follows_the_sign_of_now_minus_expires_at(
            expires_at_secs in 0i64..1_000_000_000,
            delta_secs in -1_000_000i64..1_000_000,
        ) {
            let expires_at = Utc.timestamp_opt(expires_at_secs, 0).unwrap();
            let now = expires_at + Duration::seconds(delta_secs);
            prop_assert_eq!(is_expired(expires_at, now), delta_secs >= 0);
        }
    }
}
