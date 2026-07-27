//! Claim validation: nonce and watermark rules (ADR 0004, ADR 0005,
//! `docs/protocol/peer-wire-spec.md` §3.2-§3.5, issue #423). Pure, no I/O --
//! a claim's signature is chain-specific (peer-wire-spec.md §3.5) and is
//! verified elsewhere (`connector-signer`), against the digest
//! [`claim_digest`] computes here so both the signer and every verifier
//! hash exactly the same bytes. What this module owns is the one rule every
//! claim must satisfy regardless of chain or signature scheme: its nonce
//! must strictly advance the payee's watermark, and its cumulative amount
//! must never decrease (`CONTEXT.md` "Nonce", "Watermark").

use sha2::{Digest, Sha256};
use thiserror::Error;

/// The highest nonce and cumulative amount a payee has accepted on a
/// channel so far (`CONTEXT.md` "Watermark"). Absent (`None`) before any
/// claim has ever been accepted on that channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Watermark {
    pub nonce: u64,
    pub cumulative_amount: u64,
}

/// Why a claim was rejected at the watermark layer -- mirrors
/// peer-wire-spec.md §3.4's `nonce_not_advancing`/`amount_not_advancing`
/// CLAIM_ACK rejection reasons (`signature_invalid` and `unknown_channel`
/// are not this module's concern: they depend on a verification key and a
/// channel registry, neither of which is pure domain state).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ClaimError {
    #[error("claim nonce {claimed} does not advance past the watermark's {watermark}")]
    NonceNotAdvancing { claimed: u64, watermark: u64 },

    #[error("claim amount {claimed} is less than the watermark's already-accepted {watermark}")]
    AmountNotAdvancing { claimed: u64, watermark: u64 },
}

/// Whether a claim of `nonce`/`cumulative_amount` may advance `watermark`.
/// A `None` watermark -- no claim ever accepted on this channel -- accepts
/// any nonce and amount as the channel's first watermark; there is nothing
/// yet for a first claim to fail to advance past.
pub fn validate_claim(
    watermark: Option<Watermark>,
    nonce: u64,
    cumulative_amount: u64,
) -> Result<(), ClaimError> {
    let Some(watermark) = watermark else {
        return Ok(());
    };
    if nonce <= watermark.nonce {
        return Err(ClaimError::NonceNotAdvancing {
            claimed: nonce,
            watermark: watermark.nonce,
        });
    }
    if cumulative_amount < watermark.cumulative_amount {
        return Err(ClaimError::AmountNotAdvancing {
            claimed: cumulative_amount,
            watermark: watermark.cumulative_amount,
        });
    }
    Ok(())
}

/// The watermark after accepting a claim of `nonce`/`cumulative_amount`.
/// Callers MUST have already checked [`validate_claim`] -- this does not
/// re-check, matching `condition.rs`'s split between
/// `fulfillment_matches_condition` (the check) and `derive_condition` (the
/// unconditional computation).
pub fn advance_watermark(nonce: u64, cumulative_amount: u64) -> Watermark {
    Watermark {
        nonce,
        cumulative_amount,
    }
}

/// The digest a claim's signature covers: `channel_id`, `nonce` and
/// `cumulative_amount`, big-endian, length-prefixed on `channel_id` so no
/// two distinct tuples can ever collide on the same byte string. Signing
/// and verifying a claim (`connector-signer`) both hash through this one
/// function, so neither can drift from the other's idea of what a claim
/// "says".
pub fn claim_digest(channel_id: &str, nonce: u64, cumulative_amount: u64) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update((channel_id.len() as u32).to_be_bytes());
    hasher.update(channel_id.as_bytes());
    hasher.update(nonce.to_be_bytes());
    hasher.update(cumulative_amount.to_be_bytes());
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn a_first_claim_is_accepted_with_no_watermark_yet() {
        assert!(validate_claim(None, 1, 0).is_ok());
    }

    #[test]
    fn a_claim_with_the_same_nonce_as_the_watermark_is_rejected() {
        let watermark = Watermark {
            nonce: 5,
            cumulative_amount: 100,
        };
        let err = validate_claim(Some(watermark), 5, 200).unwrap_err();
        assert_eq!(
            err,
            ClaimError::NonceNotAdvancing {
                claimed: 5,
                watermark: 5
            }
        );
    }

    #[test]
    fn a_claim_with_a_lower_nonce_than_the_watermark_is_rejected() {
        let watermark = Watermark {
            nonce: 5,
            cumulative_amount: 100,
        };
        let err = validate_claim(Some(watermark), 4, 200).unwrap_err();
        assert_eq!(
            err,
            ClaimError::NonceNotAdvancing {
                claimed: 4,
                watermark: 5
            }
        );
    }

    #[test]
    fn a_higher_nonce_with_a_lower_amount_is_rejected() {
        let watermark = Watermark {
            nonce: 5,
            cumulative_amount: 100,
        };
        let err = validate_claim(Some(watermark), 6, 99).unwrap_err();
        assert_eq!(
            err,
            ClaimError::AmountNotAdvancing {
                claimed: 99,
                watermark: 100
            }
        );
    }

    #[test]
    fn a_higher_nonce_with_the_same_amount_is_accepted() {
        let watermark = Watermark {
            nonce: 5,
            cumulative_amount: 100,
        };
        assert!(validate_claim(Some(watermark), 6, 100).is_ok());
    }

    #[test]
    fn a_higher_nonce_with_a_higher_amount_is_accepted() {
        let watermark = Watermark {
            nonce: 5,
            cumulative_amount: 100,
        };
        assert!(validate_claim(Some(watermark), 6, 150).is_ok());
    }

    #[test]
    fn advancing_the_watermark_records_exactly_the_accepted_claim() {
        let watermark = advance_watermark(7, 250);
        assert_eq!(
            watermark,
            Watermark {
                nonce: 7,
                cumulative_amount: 250
            }
        );
    }

    #[test]
    fn the_digest_changes_with_any_field() {
        let base = claim_digest("channel-a", 1, 100);
        assert_ne!(base, claim_digest("channel-b", 1, 100));
        assert_ne!(base, claim_digest("channel-a", 2, 100));
        assert_ne!(base, claim_digest("channel-a", 1, 101));
    }

    #[test]
    fn the_digest_is_deterministic() {
        assert_eq!(
            claim_digest("channel-a", 1, 100),
            claim_digest("channel-a", 1, 100)
        );
    }

    proptest! {
        /// The property the issue's acceptance criteria calls out by name:
        /// a watermark never moves backwards. Feed an arbitrary sequence of
        /// (nonce, amount) candidate claims through validate-then-advance
        /// exactly as a payee would -- rejecting anything that fails
        /// validation, applying anything that passes -- and check that the
        /// resulting watermark's nonce and amount are never smaller than
        /// they were a step ago, for every prefix of the sequence.
        #[test]
        fn a_watermark_never_moves_backwards(
            candidates in proptest::collection::vec((any::<u64>(), any::<u64>()), 0..64)
        ) {
            let mut watermark: Option<Watermark> = None;
            for (nonce, cumulative_amount) in candidates {
                let before = watermark;
                if validate_claim(watermark, nonce, cumulative_amount).is_ok() {
                    watermark = Some(advance_watermark(nonce, cumulative_amount));
                }
                if let (Some(before), Some(after)) = (before, watermark) {
                    prop_assert!(after.nonce >= before.nonce);
                    prop_assert!(after.cumulative_amount >= before.cumulative_amount);
                }
            }
        }

        /// A claim that validate_claim accepts always has a strictly
        /// greater nonce than any prior watermark -- the mechanism that
        /// makes replay gain nothing (`CONTEXT.md` "Nonce").
        #[test]
        fn an_accepted_claim_always_strictly_advances_the_nonce(
            watermark_nonce in any::<u64>(),
            watermark_amount in any::<u64>(),
            claim_nonce in any::<u64>(),
            claim_amount in any::<u64>(),
        ) {
            let watermark = Watermark { nonce: watermark_nonce, cumulative_amount: watermark_amount };
            if validate_claim(Some(watermark), claim_nonce, claim_amount).is_ok() {
                prop_assert!(claim_nonce > watermark_nonce);
                prop_assert!(claim_amount >= watermark_amount);
            }
        }
    }
}
