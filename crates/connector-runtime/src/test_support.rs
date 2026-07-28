//! Envelope-shaped test fixtures shared by every `mod tests` in this crate
//! that drives a [`crate::connector::Connector`] through a
//! [`crate::app_client::FakeAppClient`]. Issue #521 moved delivery onto the
//! structured envelope (ADR 0018/issue #519); issue #524 seals it -- a
//! `Prepare.data` is a gift wrap around a request envelope, and a
//! `Fulfill.data` (or a termination `Reject.data`) is a gift wrap around a
//! response envelope, sealed back with the same shared secret -- so every
//! test file that exercises delivery needs the same handful of builders
//! around sealing/opening and [`EnvelopeRequest`]/[`EnvelopeResponse`],
//! built once here instead of once per file.

use std::sync::{Arc, OnceLock};

use connector_domain::{EnvelopeRequest, EnvelopeResponse};
use connector_signer::giftwrap::{open_response, seal_request};
use connector_signer::{LocalSigner, Signer};

use crate::app_client::AppOutcome;
use crate::connector::FULFILLMENT_HEADER;

/// This crate's one shared "this connector's own identity" fixture: every
/// [`envelope_request_data`]/[`sealed_envelope_request_data`] call seals to
/// this key, and a `Connector` under test opens it by configuring
/// `.with_identity_signer(identity_signer())`. A single process-lifetime
/// key rather than a fresh one per call, so unrelated tests share it
/// without each needing to thread a key through by hand; a test that
/// specifically needs a *different* identity (issue #524 AC3: a forwarding
/// hop cannot open a wrap addressed elsewhere) constructs its own
/// `LocalSigner` instead of calling this.
pub(crate) fn identity_signer() -> Arc<dyn Signer> {
    static IDENTITY: OnceLock<Arc<dyn Signer>> = OnceLock::new();
    IDENTITY
        .get_or_init(|| Arc::new(LocalSigner::generate("test-support-identity")))
        .clone()
}

/// What a `Prepare`'s `data` carries per ADR 0018/issue #524 -- a gift wrap
/// sealed to [`identity_signer`]'s public key, around a minimal `POST /`
/// envelope carrying `body`. Returns the wire bytes and the shared secret
/// the wrap carries, for a caller that also wants to open the sealed
/// `Fulfill`/`Reject` this `Prepare` produces (see
/// [`open_sealed_envelope`]).
pub(crate) fn sealed_envelope_request_data(body: &[u8]) -> (Vec<u8>, [u8; 32]) {
    let plaintext = EnvelopeRequest {
        method: "POST".to_string(),
        target: "/".to_string(),
        headers: vec![],
        body: body.to_vec(),
    }
    .encode();
    seal_request(
        &plaintext,
        &identity_signer().public_key().expect("public key"),
    )
    .expect("seal")
}

/// The common case: only the wire bytes are needed, and the shared secret
/// (a fresh one every call) is discarded -- most `Prepare` construction in
/// this crate's tests just needs *a* validly sealed envelope and never
/// inspects the sealed response it produces.
pub(crate) fn envelope_request_data(body: &[u8]) -> Vec<u8> {
    sealed_envelope_request_data(body).0
}

/// Open `data` (a `Fulfill.data`, or a termination `Reject.data`) with
/// `shared_secret` and decode it as a response envelope -- the inverse of
/// what `Connector::deliver_to_app` seals with, so a test can assert on
/// what a sealed response actually carries rather than on its
/// non-deterministic ciphertext bytes.
pub(crate) fn open_sealed_envelope(shared_secret: &[u8; 32], data: &[u8]) -> EnvelopeResponse {
    let opened = open_response(shared_secret, data).expect("open sealed response");
    EnvelopeResponse::decode(&opened).expect("decode response envelope")
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

/// The response envelope `Connector::handle_prepare` seals into `Fulfill
/// .data` for an app answering `200` with `body` -- `TOON-Fulfillment` (if
/// any) is stripped before it reaches the client (issue #521), so this
/// never takes a fulfillment argument. Compare against
/// [`open_sealed_envelope`]'s result, since sealing makes the raw wire
/// bytes non-deterministic per call.
pub(crate) fn fulfill_envelope(body: &[u8]) -> EnvelopeResponse {
    fulfill_envelope_with_status(200, body)
}

pub(crate) fn fulfill_envelope_with_status(status: u16, body: &[u8]) -> EnvelopeResponse {
    EnvelopeResponse {
        status,
        headers: vec![],
        body: body.to_vec(),
    }
}
