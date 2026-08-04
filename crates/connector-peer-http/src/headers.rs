//! The request and response this carriage sees, and §3's fields as they
//! ride on them.
//!
//! # One semantic value, two encodings (spec I1)
//!
//! Every function here is a *wrapper* over the decoder the BTP carriage
//! already uses, not a second decoder:
//!
//! | Field | What actually parses it |
//! | ----- | ----------------------- |
//! | claim | [`connector_peer_btp::claim_json`] -- the client edge's own claim validator (I4) |
//! | claim ack | [`connector_peer_btp::ack`] -- the one `ClaimRejectReason` → JSON function (I3) |
//! | `minimumDelivery` | [`connector_peer_btp::fields::minimum_delivery`] -- including §5.1's "malformed is `F01`, never silently zero" |
//! | `accumulatedCost` | [`connector_peer_btp::fields::accumulated_cost`] |
//! | credential | [`connector_peer_auth::present_base64`] -- the same struct, the same JSON (§1.4) |
//!
//! Those functions take a `protocolData` entry, so this module builds one
//! from the header value and hands it over. Doing it that way rather than
//! writing "a small decimal parser, it is only four lines" is the whole
//! point: a decimal parser written twice is a rule enforced once, and the
//! rule in question converts a framing bug into an under-delivery when it is
//! missed. The header/entry *names* are never spelled here either -- they
//! come from [`connector_btp::CARRIAGE_NAMES`]'s declared pairs.
//!
//! Base64 wraps the claim, the claim ack and the credential because base64
//! is a header artifact and nothing else (§4). The value inside is the same
//! JSON the BTP entry carries raw.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use connector_btp::{
    ProtocolData, ACCUMULATED_COST_HEADER, ACCUMULATED_COST_PROTOCOL, CLAIM_ACK_HEADER,
    CLAIM_HEADER, CONTENT_TYPE_TEXT, FLUSH_REQUESTED_HEADER, MINIMUM_DELIVERY_HEADER,
    MINIMUM_DELIVERY_PROTOCOL,
};
use connector_peer_auth::SessionRole;
use connector_peer_btp::fields::MalformedMinimumDelivery;
use connector_peer_btp::{ack, fields};
use connector_runtime::ClaimAckOutcome;

/// One request's or response's headers, in arrival order and **with their
/// multiplicity intact**.
///
/// Multiplicity is load-bearing twice over: §1.5 refuses more than one
/// `Toon-Peer-Auth` rather than resolving it, and §6.4 lets
/// `Toon-Flush-Requested` appear once per channel. A map keyed by name would
/// quietly answer the first question wrong.
///
/// Names are compared case-insensitively per RFC 9110; what is stored is
/// whatever the caller wrote, and what this carriage writes is always the
/// canonical lower-case form the vectors pin (§3).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Headers(Vec<(String, String)>);

impl Headers {
    #[must_use]
    pub fn new() -> Self {
        Headers(Vec::new())
    }

    /// Add a header. Repeated names are kept, never merged into a list form.
    pub fn push(&mut self, name: impl Into<String>, value: impl Into<String>) {
        self.0.push((name.into(), value.into()));
    }

    /// Every value under `name`, case-insensitively.
    #[must_use]
    pub fn get_all(&self, name: &str) -> Vec<&str> {
        self.0
            .iter()
            .filter(|(header, _)| header.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
            .collect()
    }

    /// The first value under `name`, or `None`.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(header, _)| header.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// Every header, in order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl<'a> IntoIterator for &'a Headers {
    type Item = (&'a str, &'a str);
    type IntoIter = Box<dyn Iterator<Item = (&'a str, &'a str)> + 'a>;

    fn into_iter(self) -> Self::IntoIter {
        Box::new(self.iter())
    }
}

/// One peer request: a `POST` whose body is the OER PREPARE, or -- for a
/// FLUSH -- **empty** (§3).
///
/// There is no method and no path here on purpose. Which path a peer POSTs
/// to is the listener's business (issue #678), and the carriage's behaviour
/// must be provable without one; what §3 makes normative is the body and the
/// headers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PeerRequest {
    pub headers: Headers,
    pub body: Vec<u8>,
}

/// One peer response: the status, the headers §3 names, and the OER FULFILL
/// or REJECT as the body.
///
/// **The status is `200` regardless of the claim's verdict** (§6.2).
/// `4xx`/`5xx` are reserved for a malformed request or a connector fault --
/// cases where there is no ILP answer at all -- and a rejected claim is
/// never one of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerResponse {
    pub status: u16,
    pub headers: Headers,
    pub body: Vec<u8>,
}

impl PeerResponse {
    /// A `200` carrying `body` as the ILP answer.
    #[must_use]
    pub fn ok(body: Vec<u8>) -> Self {
        PeerResponse {
            status: 200,
            headers: Headers::new(),
            body,
        }
    }

    /// A refusal with **no ILP body**: a malformed request, per §1.5 (an
    /// ambiguous credential) and §6.2 (the statuses reserved for "there is
    /// no ILP answer at all").
    #[must_use]
    pub fn refused(status: u16) -> Self {
        PeerResponse {
            status,
            headers: Headers::new(),
            body: Vec::new(),
        }
    }

    /// Whether this response carries an ILP answer at all. A non-`200` does
    /// not, so nothing on it -- including a `Toon-Claim-Ack` -- is read as a
    /// verdict.
    #[must_use]
    pub fn answers_the_packet(&self) -> bool {
        self.status == 200
    }
}

/// A claim header whose base64 layer would not decode.
///
/// Not one of §6.1's four reasons -- those judge a claim this connector
/// could read. An unreadable one is **not acknowledged** (§6.3): the payer's
/// claim stays pending and its retransmission is read the same way, rather
/// than a verdict being recorded that was never reached.
#[derive(Debug, PartialEq, Eq)]
pub struct ClaimHeaderNotBase64;

/// The `ILP-Payment-Channel-Claim` header value for `json` (§4):
/// `base64(JSON)`, over exactly the JSON the BTP entry carries raw.
#[must_use]
pub fn claim_header_value(json: &str) -> String {
    STANDARD.encode(json)
}

/// The claim JSON a request carries, if it carries one.
///
/// A request with no claim is legal on both carriages (§10.2 item 6), so
/// `None` is an ordinary outcome and not a refusal. Where more than one
/// claim header is present the first is read, matching the BTP carriage's
/// `find` over `protocolData` -- unlike the credential, a claim is judged on
/// its own contents and cannot be smuggled past a check by a second copy.
///
/// **The privacy-wrapped carriage is not part of the peer carriage** (§4):
/// `ILP-Payment-Channel-Claim-Wrapped` is not read here at all, and a
/// peer-role request carrying one is treated as carrying no claim -- a
/// peering is configured by operators who know each other's channel
/// identity, so the anonymity it buys has no peer use.
pub fn claim_json(headers: &Headers) -> Option<Result<Vec<u8>, ClaimHeaderNotBase64>> {
    let value = headers.get(CLAIM_HEADER)?;
    Some(STANDARD.decode(value).map_err(|_| ClaimHeaderNotBase64))
}

/// The `Toon-Claim-Ack` header value for a judged claim, or `None` when
/// there is nothing to acknowledge (§6.2 forbids one on a response answering
/// a request that carried no claim).
///
/// The JSON is [`connector_peer_btp::ack::encode`]'s -- the single
/// `ClaimRejectReason` → ack function both carriages call (I3), so a fifth
/// reason cannot appear on one carriage and not the other.
#[must_use]
pub fn claim_ack_header_value(outcome: ClaimAckOutcome) -> Option<String> {
    ack::encode(outcome).map(|json| STANDARD.encode(json))
}

/// The verdict a response carries. **Absence and malformation both mean NOT
/// ACKNOWLEDGED** (§6.3), and so does a base64 layer that will not decode:
/// every shape that is not exactly one of the two the spec names returns
/// `None`, which a caller must never read as either verdict.
#[must_use]
pub fn claim_ack(headers: &Headers) -> Option<ClaimAckOutcome> {
    let value = headers.get(CLAIM_ACK_HEADER)?;
    let json = STANDARD.decode(value).ok()?;
    ack::decode(&json)
}

/// The sender's minimum-delivery declaration (§5.1), decimal uint64 ASCII,
/// one value and no list form.
///
/// **Absent means zero.** Anything present but not decimal digits, empty, or
/// over `u64::MAX` is [`MalformedMinimumDelivery`] and the caller answers
/// `F01` -- never a silent zero, which is the weakest possible floor.
///
/// `role` is taken rather than assumed because §1.7 makes this a *peer*
/// grant: on a client-role request it is **ignored**, not rejected and not
/// applied.
pub fn minimum_delivery(
    role: &SessionRole,
    headers: &Headers,
) -> Result<u64, MalformedMinimumDelivery> {
    let entries: Vec<ProtocolData> = headers
        .get(MINIMUM_DELIVERY_HEADER)
        .map(|value| entry(MINIMUM_DELIVERY_PROTOCOL, value.as_bytes()))
        .into_iter()
        .collect();
    fields::minimum_delivery(role, &entries)
}

/// The `Toon-Minimum-Delivery` header a forwarding hop re-emits, or `None`
/// for a zero floor (§5.1: absent *means* zero, so omitting it is
/// value-preserving).
///
/// The value is re-emitted **unchanged**: it is the one carriage-layer field
/// that propagates rather than being re-derived (§8.3), and crossing from
/// BTP to HTTP must not alter it.
#[must_use]
pub fn minimum_delivery_header_value(minimum_delivery: u64) -> Option<String> {
    (minimum_delivery > 0).then(|| minimum_delivery.to_string())
}

/// A REJECT's running cost (§5.2). **Absent means zero on receipt**, and a
/// relaying hop still adds its own fee to that zero.
#[must_use]
pub fn accumulated_cost(headers: &Headers) -> u64 {
    let entries: Vec<ProtocolData> = headers
        .get(ACCUMULATED_COST_HEADER)
        .map(|value| entry(ACCUMULATED_COST_PROTOCOL, value.as_bytes()))
        .into_iter()
        .collect();
    fields::accumulated_cost(&entries)
}

/// The channel ids a response prompts a flush for (§6.4), one per
/// occurrence.
///
/// It is **a hint, and only a hint**: a payer with no pending claim for a
/// named channel, or that does not recognise it, ignores it, and a payer
/// that ignores every hint is not in violation of the specification. It is
/// never answered, acknowledged, or errored on.
#[must_use]
pub fn flush_requested(headers: &Headers) -> Vec<String> {
    headers
        .get_all(FLUSH_REQUESTED_HEADER)
        // A comma-separated list form MUST NOT be used (§6.4), so a value
        // containing one is not split into channels here: it is one
        // (unrecognised) channel id, which a payer ignores.
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn entry(name: &str, data: &[u8]) -> ProtocolData {
    ProtocolData {
        name: name.to_string(),
        content_type: CONTENT_TYPE_TEXT,
        data: data.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use connector_runtime::ClaimRejectReason;

    fn peer() -> SessionRole {
        SessionRole::peer("peer-b")
    }

    fn with(name: &str, value: &str) -> Headers {
        let mut headers = Headers::new();
        headers.push(name, value);
        headers
    }

    #[test]
    fn header_lookup_is_case_insensitive_and_keeps_multiplicity() {
        let mut headers = Headers::new();
        headers.push("Toon-Flush-Requested", "0xaa");
        headers.push("toon-flush-requested", "0xbb");

        assert_eq!(
            headers.get_all("TOON-FLUSH-REQUESTED"),
            vec!["0xaa", "0xbb"]
        );
        assert_eq!(headers.get("toon-flush-requested"), Some("0xaa"));
    }

    /// §4: the header is `base64(JSON)` over exactly the JSON the BTP entry
    /// carries raw -- base64 is a header artifact and nothing more.
    #[test]
    fn the_claim_header_wraps_exactly_the_json_the_btp_entry_carries_raw() {
        let json = r#"{"version":"1.0","blockchain":"evm"}"#;

        let headers = with(CLAIM_HEADER, &claim_header_value(json));

        assert_eq!(
            claim_json(&headers).expect("a claim rode"),
            Ok(json.as_bytes().to_vec())
        );
    }

    #[test]
    fn a_request_with_no_claim_header_carries_no_claim() {
        assert!(claim_json(&Headers::new()).is_none());
    }

    /// §6.3: an unreadable claim is *not acknowledged*, not an error and not
    /// a verdict.
    #[test]
    fn a_claim_header_that_is_not_base64_is_reported_rather_than_guessed_at() {
        let headers = with(CLAIM_HEADER, "!!! not base64 !!!");

        assert_eq!(claim_json(&headers), Some(Err(ClaimHeaderNotBase64)));
    }

    /// §4: the privacy-wrapped header is not part of the peer carriage on
    /// either wire, and a peer-role request carrying one carries no claim.
    #[test]
    fn a_privacy_wrapped_claim_header_is_ignored_on_a_peer_request() {
        let headers = with("ilp-payment-channel-claim-wrapped", "d2hhdGV2ZXI=");

        assert!(claim_json(&headers).is_none());
    }

    /// I3/§6.1: the ack JSON is the BTP carriage's, wrapped -- one refusal
    /// taxonomy, two encodings.
    #[test]
    fn every_verdict_round_trips_through_the_ack_header() {
        for outcome in [
            ClaimAckOutcome::Accepted,
            ClaimAckOutcome::Rejected(ClaimRejectReason::SignatureInvalid),
            ClaimAckOutcome::Rejected(ClaimRejectReason::NonceNotAdvancing),
            ClaimAckOutcome::Rejected(ClaimRejectReason::AmountNotAdvancing),
            ClaimAckOutcome::Rejected(ClaimRejectReason::UnknownChannel),
        ] {
            let value = claim_ack_header_value(outcome).expect("a judged claim is acknowledged");
            let decoded = STANDARD.decode(&value).expect("standard base64");

            assert_eq!(decoded, ack::encode(outcome).expect("the same JSON"));
            assert_eq!(claim_ack(&with(CLAIM_ACK_HEADER, &value)), Some(outcome));
        }
    }

    /// §6.2: no ack rides a response answering a request that carried no
    /// claim, so `NotSent` has no header value at all.
    #[test]
    fn a_request_that_carried_no_claim_is_answered_with_no_ack_header() {
        assert_eq!(claim_ack_header_value(ClaimAckOutcome::NotSent), None);
    }

    /// §6.3: absence and malformation are the same "not acknowledged", and
    /// the base64 layer is one more way to be malformed.
    #[test]
    fn an_absent_or_malformed_ack_header_is_not_acknowledged() {
        assert_eq!(claim_ack(&Headers::new()), None);
        assert_eq!(claim_ack(&with(CLAIM_ACK_HEADER, "!!!")), None);
        assert_eq!(
            claim_ack(&with(CLAIM_ACK_HEADER, &STANDARD.encode("not json"))),
            None
        );
        assert_eq!(
            claim_ack(&with(
                CLAIM_ACK_HEADER,
                &STANDARD.encode(r#"{"result":"maybe"}"#)
            )),
            None
        );
        assert_eq!(
            claim_ack(&with(
                CLAIM_ACK_HEADER,
                &STANDARD.encode(r#"{"result":"rejected"}"#)
            )),
            None
        );
    }

    /// §5.1, through the BTP carriage's own parser: absent is zero, present
    /// and unreadable is refused rather than collapsed to zero.
    #[test]
    fn minimum_delivery_is_absent_zero_and_never_silently_zero_when_malformed() {
        assert_eq!(minimum_delivery(&peer(), &Headers::new()), Ok(0));
        assert_eq!(
            minimum_delivery(&peer(), &with(MINIMUM_DELIVERY_HEADER, "1250")),
            Ok(1250)
        );
        for malformed in ["", "+12", "-1", "12.5", " 12", "twelve", "1,2"] {
            assert!(
                minimum_delivery(&peer(), &with(MINIMUM_DELIVERY_HEADER, malformed)).is_err(),
                "accepted {malformed:?}"
            );
        }
    }

    /// §1.7: on a client request the field is **ignored** -- not rejected
    /// and not applied -- even when malformed.
    #[test]
    fn a_client_roles_minimum_delivery_header_is_ignored() {
        let client = SessionRole::Client;

        assert_eq!(
            minimum_delivery(&client, &with(MINIMUM_DELIVERY_HEADER, "1250")),
            Ok(0)
        );
        assert_eq!(
            minimum_delivery(&client, &with(MINIMUM_DELIVERY_HEADER, "twelve")),
            Ok(0)
        );
    }

    #[test]
    fn a_zero_floor_rides_as_an_absent_header_and_reads_back_as_zero() {
        assert_eq!(minimum_delivery_header_value(0), None);

        let value = minimum_delivery_header_value(1250).expect("a non-zero floor rides");
        assert_eq!(
            minimum_delivery(&peer(), &with(MINIMUM_DELIVERY_HEADER, &value)),
            Ok(1250)
        );
    }

    #[test]
    fn accumulated_cost_reads_back_and_absent_is_zero() {
        assert_eq!(accumulated_cost(&Headers::new()), 0);
        assert_eq!(accumulated_cost(&with(ACCUMULATED_COST_HEADER, "0")), 0);
        assert_eq!(accumulated_cost(&with(ACCUMULATED_COST_HEADER, "41")), 41);
    }

    /// §6.4: one channel id per occurrence, and a comma-separated list form
    /// is not a list -- it is one id nobody recognises, which a payer
    /// ignores.
    #[test]
    fn a_flush_prompt_is_one_channel_per_occurrence() {
        let mut headers = Headers::new();
        headers.push(FLUSH_REQUESTED_HEADER, "0xaa");
        headers.push(FLUSH_REQUESTED_HEADER, "0xbb");

        assert_eq!(flush_requested(&headers), vec!["0xaa", "0xbb"]);
        assert!(flush_requested(&Headers::new()).is_empty());
        assert_eq!(
            flush_requested(&with(FLUSH_REQUESTED_HEADER, "0xaa,0xbb")),
            vec!["0xaa,0xbb"]
        );
    }
}
