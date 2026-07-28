//! Envelope-shaped test fixtures shared by every `mod tests` in this crate
//! that drives a [`crate::connector::Connector`] through a
//! [`crate::app_client::FakeAppClient`]. Issue #521 moved delivery onto the
//! structured envelope (ADR 0018/issue #519): a `Prepare.data` is a
//! request envelope and a `Fulfill.data` is a response envelope rather
//! than either being a raw payload, so every test file that exercises
//! delivery needs the same handful of builders around
//! [`EnvelopeRequest`]/[`EnvelopeResponse`] -- built once here instead of
//! once per file.

use connector_domain::{EnvelopeRequest, EnvelopeResponse};

use crate::app_client::AppOutcome;
use crate::connector::FULFILLMENT_HEADER;

/// What a `Prepare`'s `data` carries per ADR 0018/issue #519 -- a
/// structured envelope, still plaintext at this point (sealing is issue
/// #524). A minimal `POST /` envelope around `body`, enough to exercise a
/// real decode rather than a raw opaque payload the old pre-#521 delivery
/// path used.
pub(crate) fn envelope_request_data(body: &[u8]) -> Vec<u8> {
    EnvelopeRequest {
        method: "POST".to_string(),
        target: "/".to_string(),
        headers: vec![],
        body: body.to_vec(),
    }
    .encode()
}

/// Hex-encode `fulfillment` the way an app's `TOON-Fulfillment` response
/// header carries it (issue #417) -- the inverse of
/// `connector::decode_fulfillment_header`.
fn encode_fulfillment_header(fulfillment: [u8; 32]) -> String {
    fulfillment
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The `AppOutcome` a `FakeAppClient` produces for an app that answers
/// `200` with `body`, optionally claiming `fulfillment` via the
/// `TOON-Fulfillment` response header (issue #417's still-standing
/// mechanism, until #525 derives a fulfilment from a sealed secret
/// instead).
pub(crate) fn answered(body: &[u8], fulfillment: Option<[u8; 32]>) -> AppOutcome {
    answered_with_status(200, body, fulfillment)
}

pub(crate) fn answered_with_status(
    status: u16,
    body: &[u8],
    fulfillment: Option<[u8; 32]>,
) -> AppOutcome {
    let headers = fulfillment
        .map(|fulfillment| {
            vec![(
                FULFILLMENT_HEADER.to_string(),
                encode_fulfillment_header(fulfillment),
            )]
        })
        .unwrap_or_default();
    AppOutcome::Answered {
        response: EnvelopeResponse {
            status,
            headers,
            body: body.to_vec(),
        },
    }
}

/// The exact `Fulfill.data` bytes `Connector::handle_prepare` produces for
/// an app answering `200` with `body` -- a response envelope, with
/// `TOON-Fulfillment` (if any) stripped before it reaches the client
/// (issue #521), so this never takes a fulfillment argument.
pub(crate) fn fulfill_data(body: &[u8]) -> Vec<u8> {
    fulfill_data_with_status(200, body)
}

pub(crate) fn fulfill_data_with_status(status: u16, body: &[u8]) -> Vec<u8> {
    EnvelopeResponse {
        status,
        headers: vec![],
        body: body.to_vec(),
    }
    .encode()
}
