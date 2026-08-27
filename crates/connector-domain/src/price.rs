//! What a terminated route charges for one packet
//! ([ADR 0065](../../../docs/adr/0065-a-price-is-a-schedule-over-payload-length.md),
//! issue #984): a **schedule** over the packet's payload length rather than
//! the single flat number [ADR 0020](../../../docs/adr/0020-a-price-is-flat-and-attaches-to-a-handler.md)
//! fixed, and flat exactly when its slope is zero.
//!
//! The measured quantity is `Prepare.data.len()` -- the length of the sealed
//! gift wrap (ADR 0018), never anything inside it. That is a property of
//! **carriage**, not of content (ADR 0016): every hop can measure it without
//! opening the wrap, which is what lets a forwarded route be priced at the
//! client edge (ADR 0028) and a peer arrival be gated (ADR 0029) by the same
//! rule a termination charges under. It is also exactly what the sender
//! produced, so a sender computes the charge itself before it sends.
//!
//! Why per **KiB** rather than per byte: at the fleet's 6-decimal USDC the
//! slope issue #984 measured against a real Arweave upstream is ~30 base
//! units per KiB, which is ~0.03 per byte -- not representable in the integer
//! base units every amount on the value path is counted in. Per-byte pricing
//! would round that to zero, which is the same defect ADR 0010 removed from
//! the basis-point fee.
//!
//! A **fee** does not gain a slope and stays flat per packet (ADR 0010, ADR
//! 0061): carriage work does not scale with a payload the way the work behind
//! a termination does. [`crate::amount_after_fee`] is unchanged.

use std::fmt;

use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// How many bytes one step of `per_kib` buys. A kibibyte, not a kilobyte:
/// payload lengths are byte counts and every other size in this system is
/// binary, so the round number belongs where the arithmetic is.
const BYTES_PER_KIB: u64 = 1024;

/// What a route charges for one packet: a flat `base`, plus `per_kib` for
/// every started kibibyte of that packet's payload.
///
/// A **struct rather than an enum**, deliberately: `price = 1000` and
/// `price = { base = 1000, per_kib = 0 }` are then the *same value*, so the
/// two spellings can never be told apart by anything downstream -- the
/// handler-consistency check (`connector_config`'s
/// `insert_consistent_handler_price`) stays a plain `==`, and a route that
/// starts flat and gains a slope is a change of one field rather than a
/// change of shape.
///
/// Both fields are in the settlement asset's base units, like every other
/// amount on the value path: nothing scales by `decimals`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Price {
    base: u64,
    per_kib: u64,
}

impl Price {
    /// Deliberately free -- what a route with `price = 0` charges, and the
    /// figure a destination this connector serves no route for is treated as
    /// costing while routing decides what to say about it.
    pub const FREE: Price = Price {
        base: 0,
        per_kib: 0,
    };

    /// A flat price: the same charge whatever the packet carries, which is
    /// every route ADR 0020 could express and every route the fleet runs
    /// today.
    pub const fn flat(base: u64) -> Price {
        Price { base, per_kib: 0 }
    }

    /// A price with a slope: `base` for the packet, plus `per_kib` for every
    /// started kibibyte of its payload.
    pub const fn scheduled(base: u64, per_kib: u64) -> Price {
        Price { base, per_kib }
    }

    /// What this route charges for a packet of any size -- the floor of the
    /// schedule, and the whole of a flat price.
    pub const fn base(&self) -> u64 {
        self.base
    }

    /// The slope: what each started kibibyte of payload adds. Zero on a flat
    /// price.
    pub const fn per_kib(&self) -> u64 {
        self.per_kib
    }

    /// Whether this schedule charges the same for every packet. True exactly
    /// when the slope is zero, which is what makes ADR 0020's flat price a
    /// value of this type rather than a separate case.
    pub const fn is_flat(&self) -> bool {
        self.per_kib == 0
    }

    /// Whether this route is free at every size -- a flat zero. Distinct from
    /// [`charge`](Self::charge) returning zero, which a `{ base = 0 }`
    /// schedule also does for an empty payload.
    pub const fn is_free(&self) -> bool {
        self.base == 0 && self.per_kib == 0
    }

    /// What this schedule charges for one packet whose payload is
    /// `payload_len` bytes: `base + per_kib * ceil(payload_len / 1024)`.
    ///
    /// `payload_len` is `Prepare.data.len()` at every gate that charges --
    /// the client edge (both carriages), the peer price gate, a probe's
    /// reject and the termination itself -- so every hop evaluating this
    /// schedule for one packet gets one answer.
    ///
    /// Saturating throughout, and so total: an operator can write a slope
    /// that overflows a `u64` on a large payload, and the answer is then
    /// `u64::MAX` -- a charge no claim can cover, which refuses the packet.
    /// A panic on the packet path would be the worse failure.
    pub fn charge(&self, payload_len: usize) -> u64 {
        let bytes = u64::try_from(payload_len).unwrap_or(u64::MAX);
        let kib = bytes.div_ceil(BYTES_PER_KIB);
        self.base.saturating_add(self.per_kib.saturating_mul(kib))
    }
}

impl fmt::Display for Price {
    /// `1000` when flat -- the spelling an operator wrote and the one every
    /// pre-schedule message already used -- and `1000 + 30/KiB` when it has a
    /// slope, so an error naming two prices names what distinguishes them.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_flat() {
            write!(f, "{}", self.base)
        } else {
            write!(f, "{} + {}/KiB", self.base, self.per_kib)
        }
    }
}

impl Serialize for Price {
    /// A bare integer when flat, a `{ base, per_kib }` table otherwise.
    ///
    /// The flat case matters twice over: every JSON document this connector
    /// publishes for a flat route stays byte-identical to what it published
    /// before schedules existed, and a runtime peer-route snapshot written by
    /// an older binary (`"price": 25`) still reads back through
    /// [`Deserialize`] as the same value this writes.
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if self.is_flat() {
            serializer.serialize_u64(self.base)
        } else {
            use serde::ser::SerializeMap;
            let mut map = serializer.serialize_map(Some(2))?;
            map.serialize_entry("base", &self.base)?;
            map.serialize_entry("per_kib", &self.per_kib)?;
            map.end()
        }
    }
}

/// One non-negative integer field of a price table, with its own refusal.
///
/// A `u64` alone would report a negative `base` through whichever
/// deserializer happened to be running; TOML's message for that names the
/// type rather than the field. This keeps the refusal in one place and in
/// this module's own words.
struct NonNegative(u64);

impl<'de> Deserialize<'de> for NonNegative {
    fn deserialize<D>(deserializer: D) -> Result<NonNegative, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct NonNegativeVisitor;

        impl Visitor<'_> for NonNegativeVisitor {
            type Value = NonNegative;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a non-negative integer of the settlement asset's base units")
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<NonNegative, E> {
                Ok(NonNegative(value))
            }

            fn visit_i64<E: de::Error>(self, value: i64) -> Result<NonNegative, E> {
                u64::try_from(value).map(NonNegative).map_err(|_| {
                    E::custom(format!(
                        "a price is never negative, and this one is {value}"
                    ))
                })
            }
        }

        deserializer.deserialize_any(NonNegativeVisitor)
    }
}

impl<'de> Deserialize<'de> for Price {
    /// Accepts an integer (`price = 1000`) or a table
    /// (`price = { base = 1000, per_kib = 30 }`), and refuses everything else
    /// **by name**.
    ///
    /// Hand-written rather than `#[serde(untagged)]`: untagged reports every
    /// failure as "data did not match any variant", so a table with a
    /// mistyped key would tell an operator only that their price was not a
    /// price. This crate's whole doctrine is that a configuration error names
    /// what is wrong with it (ADR 0009), and a price is the field an operator
    /// is most likely to get wrong.
    fn deserialize<D>(deserializer: D) -> Result<Price, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct PriceVisitor;

        impl<'de> Visitor<'de> for PriceVisitor {
            type Value = Price;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a price: an integer, or a { base, per_kib } table")
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Price, E> {
                Ok(Price::flat(value))
            }

            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Price, E> {
                u64::try_from(value).map(Price::flat).map_err(|_| {
                    E::custom(format!(
                        "a price is never negative, and this one is {value}"
                    ))
                })
            }

            fn visit_map<M>(self, mut map: M) -> Result<Price, M::Error>
            where
                M: MapAccess<'de>,
            {
                let mut base: Option<u64> = None;
                let mut per_kib: Option<u64> = None;

                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "base" => {
                            if base.is_some() {
                                return Err(de::Error::custom(
                                    "a price table names 'base' twice; it takes one value",
                                ));
                            }
                            base = Some(map.next_value::<NonNegative>()?.0);
                        }
                        "per_kib" => {
                            if per_kib.is_some() {
                                return Err(de::Error::custom(
                                    "a price table names 'per_kib' twice; it takes one value",
                                ));
                            }
                            per_kib = Some(map.next_value::<NonNegative>()?.0);
                        }
                        other => {
                            return Err(de::Error::custom(format!(
                                "unknown key '{other}' in a price table, which takes exactly \
                                 'base' and 'per_kib'"
                            )));
                        }
                    }
                }

                // Both required, and `per_kib` for a reason worth stating:
                // the table form exists only to carry a slope, and the flat
                // form already spells the no-slope case. Defaulting a missing
                // `per_kib` to zero would let a schedule an operator meant to
                // charge by size go out silently flat -- which is the failure
                // ADR 0009 refuses a key by name to prevent.
                let base = base.ok_or_else(|| {
                    de::Error::custom(
                        "a price table is missing 'base', the flat part every packet pays",
                    )
                })?;
                let per_kib = per_kib.ok_or_else(|| {
                    de::Error::custom(
                        "a price table is missing 'per_kib'. Write 'per_kib = 0' if this route \
                         is meant to charge the same at every size, or write the price as a bare \
                         integer, which means the same thing",
                    )
                })?;

                Ok(Price::scheduled(base, per_kib))
            }
        }

        deserializer.deserialize_any(PriceVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn a_flat_price_charges_the_same_at_every_size() {
        let price = Price::flat(1000);
        assert_eq!(price.charge(0), 1000);
        assert_eq!(price.charge(1), 1000);
        assert_eq!(price.charge(100 * 1024), 1000);
        assert!(price.is_flat());
    }

    #[test]
    fn a_zero_slope_is_the_same_value_as_a_flat_price() {
        // Not merely equivalent: the same value, so nothing downstream can
        // tell the two spellings apart.
        assert_eq!(Price::scheduled(1000, 0), Price::flat(1000));
    }

    #[test]
    fn the_worked_example_from_issue_984() {
        // The measured Arweave-upstream slope: break-even runs from ~3,000
        // base units at 100 KB to ~60,900 at 2 MiB, a span one scalar cannot
        // express. At 30/KiB over a 1,000 base:
        let price = Price::scheduled(1000, 30);
        assert_eq!(price.charge(100 * 1024), 4_000);
        assert_eq!(price.charge(2 * 1024 * 1024), 62_440);
        // ...and the same slope per *byte* would be 0.03 base units, which
        // rounds to zero in the integer units every amount is counted in.
        // That is why the unit is a kibibyte.
    }

    #[test]
    fn an_empty_payload_charges_the_base_alone() {
        assert_eq!(Price::scheduled(100, 10).charge(0), 100);
    }

    #[test]
    fn a_started_kibibyte_is_a_whole_one() {
        let price = Price::scheduled(0, 7);
        assert_eq!(price.charge(1), 7);
        assert_eq!(price.charge(1024), 7);
        assert_eq!(price.charge(1025), 14);
    }

    #[test]
    fn charging_saturates_rather_than_panicking() {
        assert_eq!(Price::scheduled(u64::MAX, 1).charge(1), u64::MAX);
        assert_eq!(Price::scheduled(0, u64::MAX).charge(2049), u64::MAX);
        assert_eq!(
            Price::scheduled(u64::MAX, u64::MAX).charge(usize::MAX),
            u64::MAX
        );
    }

    #[test]
    fn free_is_free_at_every_size() {
        assert!(Price::FREE.is_free());
        assert_eq!(Price::FREE.charge(10 * 1024 * 1024), 0);
        // A zero base with a slope is not free -- only its empty-payload
        // charge is.
        assert!(!Price::scheduled(0, 1).is_free());
    }

    #[test]
    fn display_is_the_operators_own_spelling() {
        assert_eq!(Price::flat(1000).to_string(), "1000");
        assert_eq!(Price::scheduled(1000, 30).to_string(), "1000 + 30/KiB");
    }

    #[test]
    fn a_flat_price_parses_from_a_bare_integer() {
        let price: Price = serde_json::from_str("1000").expect("an integer is a price");
        assert_eq!(price, Price::flat(1000));
    }

    #[test]
    fn a_schedule_parses_from_a_table() {
        let price: Price =
            serde_json::from_str(r#"{"base":1000,"per_kib":30}"#).expect("a table is a price");
        assert_eq!(price, Price::scheduled(1000, 30));
    }

    #[test]
    fn a_flat_price_serializes_as_a_bare_integer() {
        // What keeps every published document for a flat route byte-identical
        // to what it was before schedules existed.
        assert_eq!(
            serde_json::to_string(&Price::flat(1000)).expect("serializes"),
            "1000"
        );
        assert_eq!(
            serde_json::to_string(&Price::scheduled(1000, 30)).expect("serializes"),
            r#"{"base":1000,"per_kib":30}"#
        );
    }

    #[test]
    fn a_table_missing_per_kib_is_refused_by_name() {
        let error = serde_json::from_str::<Price>(r#"{"base":1}"#)
            .expect_err("a slopeless table is refused");
        assert!(
            error.to_string().contains("per_kib"),
            "the refusal must name the missing key, got: {error}"
        );
    }

    #[test]
    fn a_table_missing_base_is_refused_by_name() {
        let error = serde_json::from_str::<Price>(r#"{"per_kib":1}"#)
            .expect_err("a baseless table is refused");
        assert!(
            error.to_string().contains("base"),
            "the refusal must name the missing key, got: {error}"
        );
    }

    #[test]
    fn an_unknown_key_in_a_price_table_is_refused_by_name() {
        let error = serde_json::from_str::<Price>(r#"{"base":1,"per_kib":2,"per_byte":3}"#)
            .expect_err("an unknown key is refused");
        let message = error.to_string();
        assert!(
            message.contains("per_byte"),
            "the refusal must name the offending key, got: {message}"
        );
    }

    #[test]
    fn a_price_that_is_neither_an_integer_nor_a_table_is_refused() {
        let error =
            serde_json::from_str::<Price>(r#""1000""#).expect_err("a string is not a price");
        assert!(
            error.to_string().contains("price"),
            "the refusal must say what a price is, got: {error}"
        );
    }

    #[test]
    fn a_negative_price_is_refused() {
        let error = serde_json::from_str::<Price>("-1").expect_err("a negative price is refused");
        assert!(error.to_string().contains("never negative"), "got: {error}");
    }

    #[test]
    fn a_pre_schedule_snapshot_still_reads_back() {
        // A runtime peer-route snapshot written by a binary that predates
        // this type carries a bare integer.
        let price: Price = serde_json::from_str("25").expect("an old snapshot still loads");
        assert_eq!(price, Price::flat(25));
        assert_eq!(price.charge(4096), 25);
    }

    proptest! {
        #[test]
        fn a_flat_price_charges_its_base_whatever_the_length(
            base in any::<u64>(),
            len in 0usize..=(4 * 1024 * 1024),
        ) {
            prop_assert_eq!(Price::flat(base).charge(len), base);
        }

        #[test]
        fn a_zero_slope_charges_exactly_what_a_flat_price_does(
            base in any::<u64>(),
            len in 0usize..=(4 * 1024 * 1024),
        ) {
            prop_assert_eq!(
                Price::scheduled(base, 0).charge(len),
                Price::flat(base).charge(len)
            );
        }

        #[test]
        fn charging_never_falls_as_a_payload_grows(
            base in any::<u64>(),
            per_kib in any::<u64>(),
            shorter in 0usize..=(4 * 1024 * 1024),
            extra in 0usize..=(4 * 1024 * 1024),
        ) {
            let price = Price::scheduled(base, per_kib);
            prop_assert!(price.charge(shorter) <= price.charge(shorter + extra));
        }

        #[test]
        fn a_whole_kibibyte_charges_for_exactly_that_many(
            base in 0u64..1_000_000,
            per_kib in 0u64..1_000_000,
            kib in 1usize..4096,
        ) {
            let price = Price::scheduled(base, per_kib);
            let kib_u64 = kib as u64;
            prop_assert_eq!(price.charge(kib * 1024), base + per_kib * kib_u64);
            // One byte past a boundary starts the next kibibyte.
            prop_assert_eq!(
                price.charge(kib * 1024 + 1),
                base + per_kib * (kib_u64 + 1)
            );
        }

        #[test]
        fn charging_is_total(
            base in any::<u64>(),
            per_kib in any::<u64>(),
            len in any::<usize>(),
        ) {
            // No panic, no overflow: the only contract the packet path needs.
            let _ = Price::scheduled(base, per_kib).charge(len);
        }

        #[test]
        fn serde_round_trips(base in any::<u64>(), per_kib in any::<u64>()) {
            let price = Price::scheduled(base, per_kib);
            let json = serde_json::to_string(&price).expect("serializes");
            let read: Price = serde_json::from_str(&json).expect("reads back");
            prop_assert_eq!(read, price);
        }
    }
}
