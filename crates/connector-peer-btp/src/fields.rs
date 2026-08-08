//! Carriage-layer fields (`peer-carriage-spec.md` §5): the two values
//! RFC-0027 has no field for, riding as protocolData entries.
//!
//! §8.3's layering invariant is why they ride here at all: **carriage-layer
//! fields are never sealed, and sealed payloads are never carriage-layer
//! fields**, precisely so a hop can read and judge them without opening a
//! payload it holds no key for.

use connector_btp::{
    ProtocolData, ACCUMULATED_COST_PROTOCOL, CONTENT_TYPE_TEXT, PAYMENT_REQUIRED_PROTOCOL,
};
use connector_domain::x402::{parse_greeting, GreetingError, X402PaymentRequired};
use connector_domain::{Reject, RejectCode};
use connector_peer_auth::SessionRole;

/// A `toon-minimum-delivery` entry that was present but unreadable (§5.1).
///
/// Deliberately not collapsible to zero: zero is the weakest possible
/// floor, and quietly substituting it for an unparseable one converts a
/// framing bug into an under-delivery. The caller answers `F01`.
#[derive(Debug, PartialEq, Eq)]
pub struct MalformedMinimumDelivery(pub String);

/// Read the original sender's minimum-delivery declaration off a peer
/// MESSAGE (§5.1): decimal uint64 as UTF-8 text, no sign and no leading
/// `+`.
///
/// **Absent means zero** -- a claim-free floor is the correct default and
/// the one the deleted wire's fixed-width field expressed as `0`. Anything
/// present but not decimal digits, empty, or over `u64::MAX` is
/// [`MalformedMinimumDelivery`].
///
/// `role` is taken rather than assumed because §1.7 makes this field a
/// *peer* grant: on a client-role interaction it MUST be **ignored** --
/// not rejected and not applied -- so a client SDK that sets an
/// unrecognised entry is not broken by a peer feature. Ignoring is
/// [`connector_peer_auth::honoured_minimum_delivery`]'s job and it is
/// called here rather than re-derived.
pub fn minimum_delivery(
    role: &SessionRole,
    protocol_data: &[ProtocolData],
) -> Result<u64, MalformedMinimumDelivery> {
    let entry = protocol_data
        .iter()
        .find(|pd| pd.name == connector_btp::MINIMUM_DELIVERY_PROTOCOL);
    let Some(entry) = connector_peer_auth::honoured_minimum_delivery(role, entry) else {
        return Ok(0);
    };
    let text = std::str::from_utf8(&entry.data)
        .map_err(|_| MalformedMinimumDelivery("not valid UTF-8".to_string()))?;
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(MalformedMinimumDelivery(format!(
            "'{text}' is not a decimal uint64"
        )));
    }
    text.parse::<u64>()
        .map_err(|_| MalformedMinimumDelivery(format!("'{text}' does not fit in a u64")))
}

/// The `toon-minimum-delivery` entry a forwarding hop re-emits, or `None`
/// for a zero floor.
///
/// §5.1: a forwarding hop MUST re-emit the value **unchanged** on its
/// outbound PREPARE, on whichever carriage that hop uses -- this is the one
/// carriage-layer field that propagates rather than being re-derived
/// (§8.3). Omitting it for zero is value-preserving, since absent *means*
/// zero on receipt.
pub fn minimum_delivery_protocol_data(minimum_delivery: u64) -> Option<ProtocolData> {
    (minimum_delivery > 0).then(|| ProtocolData {
        name: connector_btp::MINIMUM_DELIVERY_PROTOCOL.to_string(),
        content_type: CONTENT_TYPE_TEXT,
        data: minimum_delivery.to_string().into_bytes(),
    })
}

/// The `F01` a malformed minimum-delivery provokes (§5.1).
pub fn malformed_minimum_delivery_reject(error: &MalformedMinimumDelivery) -> Reject {
    Reject {
        code: RejectCode::f01_invalid_packet(),
        triggered_by: String::new(),
        message: format!("malformed toon-minimum-delivery: {}", error.0),
        data: Vec::new(),
        accumulated_cost: 0,
    }
}

/// The `toon-accumulated-cost` entry on a REJECT's RESPONSE (§5.2).
///
/// Already implemented on the client edge and **reused verbatim** -- same
/// entry name, same decimal uint64 text. Two carriage-level requirements
/// live here: the field rides **only** a REJECT (never beside a FULFILL),
/// and a hop **always** emits it on a REJECT it sends even when the value
/// is `0`, so that "absent" never has to carry meaning in the direction
/// that matters.
pub fn accumulated_cost_protocol_data(accumulated_cost: u64) -> ProtocolData {
    ProtocolData {
        name: ACCUMULATED_COST_PROTOCOL.to_string(),
        content_type: CONTENT_TYPE_TEXT,
        data: accumulated_cost.to_string().into_bytes(),
    }
}

/// Read a REJECT's accumulated cost back. **Absent means zero on receipt**
/// (§5.2), and a relaying hop still adds its own fee to that zero before
/// passing the REJECT upstream.
pub fn accumulated_cost(protocol_data: &[ProtocolData]) -> u64 {
    protocol_data
        .iter()
        .find(|pd| pd.name == ACCUMULATED_COST_PROTOCOL)
        .and_then(|pd| std::str::from_utf8(&pd.data).ok())
        .and_then(|text| text.parse().ok())
        .unwrap_or(0)
}

/// The x402 terms a REJECT's `payment-required` entry carries (issue #874),
/// the BTP twin of the HTTP 402's `Payment-Required` header -- and by
/// construction the identical bytes, since the client edge serves both from
/// one `x402_terms_body`.
///
/// Three answers, and the difference between the last two is the whole
/// point:
///
/// * `None` -- no such entry. The peer answered without greeting us; this
///   is an ordinary answer and nothing is owed.
/// * `Some(Err(_))` -- an entry was there and could not be read. **Never
///   collapsed into `None`**: doing so would read a framing bug, a
///   truncated frame or a future x402 version as "no payment required" and
///   hand the far side a free-ride verdict it never gave.
/// * `Some(Ok(terms))` -- the terms this connector has to satisfy.
///
/// The parse itself is [`connector_domain::x402::parse_greeting`], shared
/// with whatever reads the HTTP carriage's 402: the greeting is not a BTP
/// concept, only its carriage is.
pub fn payment_required(
    protocol_data: &[ProtocolData],
) -> Option<Result<X402PaymentRequired, GreetingError>> {
    let entry = protocol_data
        .iter()
        .find(|pd| pd.name == PAYMENT_REQUIRED_PROTOCOL)?;
    Some(parse_greeting(&entry.data))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, data: &[u8]) -> ProtocolData {
        ProtocolData {
            name: name.to_string(),
            content_type: CONTENT_TYPE_TEXT,
            data: data.to_vec(),
        }
    }

    fn md(data: &[u8]) -> Vec<ProtocolData> {
        vec![entry(connector_btp::MINIMUM_DELIVERY_PROTOCOL, data)]
    }

    fn peer() -> SessionRole {
        SessionRole::peer("peer-b")
    }

    #[test]
    fn an_absent_minimum_delivery_is_zero() {
        assert_eq!(minimum_delivery(&peer(), &[]), Ok(0));
    }

    #[test]
    fn a_decimal_minimum_delivery_is_read_as_written() {
        assert_eq!(minimum_delivery(&peer(), &md(b"1250")), Ok(1250));
        assert_eq!(minimum_delivery(&peer(), &md(b"0")), Ok(0));
        assert_eq!(
            minimum_delivery(&peer(), &md(u64::MAX.to_string().as_bytes())),
            Ok(u64::MAX)
        );
    }

    /// §5.1: never silently zero. Zero is the weakest floor, and
    /// substituting it for an unparseable one turns a framing bug into an
    /// under-delivery.
    #[test]
    fn a_malformed_minimum_delivery_is_refused_rather_than_treated_as_zero() {
        for malformed in [
            &b""[..],
            b"+12",
            b"-1",
            b"12.5",
            b" 12",
            b"twelve",
            b"18446744073709551616", // u64::MAX + 1
        ] {
            assert!(
                minimum_delivery(&peer(), &md(malformed)).is_err(),
                "accepted {malformed:?}"
            );
        }
    }

    /// §1.7: on a client interaction the field is **ignored** -- not
    /// rejected and not applied -- even when it is the same bytes a peer
    /// would have honoured, and even when it is malformed.
    #[test]
    fn a_client_roles_minimum_delivery_is_ignored_never_honoured_and_never_refused() {
        let client = SessionRole::Client;

        assert_eq!(minimum_delivery(&client, &md(b"1250")), Ok(0));
        assert_eq!(minimum_delivery(&client, &md(b"twelve")), Ok(0));
    }

    #[test]
    fn a_zero_floor_rides_as_an_absent_entry_and_reads_back_as_zero() {
        assert_eq!(minimum_delivery_protocol_data(0), None);

        let entry = minimum_delivery_protocol_data(1250).expect("a non-zero floor rides");
        assert_eq!(minimum_delivery(&peer(), &[entry]), Ok(1250));
    }

    /// §5.2: always emitted on a REJECT, even at zero, so "absent" never
    /// has to carry meaning in the direction that matters.
    #[test]
    fn accumulated_cost_round_trips_and_absent_reads_as_zero() {
        assert_eq!(accumulated_cost(&[]), 0);
        assert_eq!(accumulated_cost(&[accumulated_cost_protocol_data(0)]), 0);
        assert_eq!(accumulated_cost(&[accumulated_cost_protocol_data(41)]), 41);
    }

    fn greeting(body: &[u8]) -> Vec<ProtocolData> {
        vec![entry(PAYMENT_REQUIRED_PROTOCOL, body)]
    }

    const TERMS: &[u8] = br#"{"x402Version":2,"resource":{"url":"g.toon.relay"},
        "accepts":[{"amount":"2000","payTo":"g.toon.relay"}]}"#;

    #[test]
    fn an_answer_with_no_greeting_asks_for_nothing() {
        assert!(payment_required(&[]).is_none());
        assert!(payment_required(&[accumulated_cost_protocol_data(41)]).is_none());
    }

    #[test]
    fn a_greeting_yields_the_terms_to_satisfy() {
        let terms = payment_required(&greeting(TERMS))
            .expect("the entry is there")
            .expect("and it reads");
        assert_eq!(terms.price(), Some(2000));
        assert_eq!(terms.pay_to(), Some("g.toon.relay"));
    }

    /// Issue #874's load-bearing distinction: an unreadable greeting is an
    /// error, never the `None` that means "nothing was asked for".
    #[test]
    fn an_unreadable_greeting_is_an_error_not_an_absence() {
        for garbage in [&b""[..], b"{", b"null", br#"{"error":"no route"}"#] {
            let read = payment_required(&greeting(garbage));
            assert!(
                matches!(read, Some(Err(_))),
                "{garbage:?} was not read as a malformed greeting: {read:?}"
            );
        }
    }
}
