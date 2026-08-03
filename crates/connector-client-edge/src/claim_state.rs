//! `POST /ilp/claim-state` (issue #693, epic toon-meta#261): an
//! owner-authenticated bulk read of claim state -- deposit total,
//! cumulative claimed, available balance, nonce, last-claim time -- over
//! every channel a caller can prove it controls, in one request.
//!
//! **Why this shape.** The fleet-money epic's decision 5 makes this
//! connector the source of truth for a channel's off-chain claim
//! watermark: an agent's own client and this connector's claim gate are
//! the only two parties who know it, and an agent that is broke or dead
//! cannot afford to publish it itself (a report event would cost a paid
//! write). A human managing N agents needs this for every channel at
//! once, not one HTTP round trip per agent, and needs it to answer
//! correctly precisely when the agent it is asking about cannot answer
//! for itself.
//!
//! **Auth.** Per-channel, not per-request: each entry in the request
//! carries its own signature proving control of *that* channel, over a
//! domain-separated challenge (`connector_signer::claim_state_challenge`)
//! distinct from a real claim's balance-proof signature -- reusing the
//! claim signature scheme would make a captured challenge replayable as a
//! payment and vice versa. Verification is against the channel's already
//! *registered* counterparty (`ClientChannelRegistry`, issue #558's rule
//! applied to a read instead of a write) -- an owner whose agent keys
//! derive from its own seed can sign as any agent's channel this way, and
//! the connector never needs to know anything about that derivation; it
//! only ever checks "does this signature verify against this channel's
//! recorded key", exactly as claim verification does.
//!
//! **What a failure reveals.** Every reason a channel entry cannot be
//! answered -- it does not exist, the signature does not verify, this
//! connector's resolution of it failed -- collapses to one generic
//! `"unverified"` result. This is deliberately more conservative than
//! claim ingestion's own refusal taxonomy (client-edge-spec.md §1.3, which
//! *does* distinguish "no such channel" from "bad signature" for a payer's
//! benefit): this endpoint's whole acceptance criterion is that a caller
//! learns nothing about a channel it does not control, and "channel
//! exists but your signature is wrong" already tells an attacker the
//! channel exists. `"expired"` is the one distinct reason, because it is
//! a fact about the caller's own request, not about the channel.
//!
//! **The admission path is untouched.** This handler only reads --
//! [`crate::ClientClaimGate::watermark`], [`crate::ClientClaimGate::channels`],
//! [`crate::ClientClaimGate::last_claim_time`] -- and a channel lookup that
//! is not already known goes through the same budgeted
//! [`crate::channels::ClientChannelRegistry::evm`]/`::solana` resolution a
//! claim's own channel lookup does, so a flood of fabricated channel ids
//! against this endpoint is bounded exactly as issue #613 already bounds
//! it for claims. Nothing here calls `ingest`/`admit`, and no new work
//! lands on `handle_prepare`'s packet path (see #686/#690).

use std::sync::Arc;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};

use connector_signer::{
    verify_evm_claim_state_challenge, verify_solana_claim_state_challenge, EvmClaimStateChallenge,
};

use crate::channels::{decode_base58_bytes, decode_hex_bytes, DepositFloor};
use crate::{hex_encode, now_unix, ClientEdgeState};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaimStateRequest {
    channels: Vec<ChannelProofRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "blockchain", rename_all = "lowercase")]
enum ChannelProofRequest {
    #[serde(rename_all = "camelCase")]
    Evm {
        channel_id: String,
        expires: u64,
        signature: String,
    },
    #[serde(rename_all = "camelCase")]
    Solana {
        channel_account: String,
        expires: u64,
        signature: String,
    },
}

#[derive(Debug, Serialize)]
pub(crate) struct ClaimStateResponse {
    channels: Vec<ChannelStateResult>,
}

/// One requested channel's answer -- serialized flat (no enum tag) so the
/// wire shape is exactly `{"ok": true, ...state} | {"ok": false, "error":
/// "..."}`, matched on `ok` rather than a discriminant field a consumer
/// would need to know this crate's Rust type names to interpret.
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum ChannelStateResult {
    Verified(VerifiedChannelState),
    Unverified(UnverifiedChannelState),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedChannelState {
    blockchain: &'static str,
    channel_id: String,
    ok: bool,
    /// `null` for a declared (`[[client_channels]]`) channel, which names
    /// no amount ([`DepositFloor::Unknown`]) -- see
    /// `crate::channels`'s own doc for why that is a deliberate exemption,
    /// not a gap. A decimal string, matching the incoming claim wire's own
    /// `transferredAmount` convention, since this is a monetary value a
    /// JS `Number` cannot represent exactly past 2^53.
    deposit_total: Option<String>,
    cumulative_claimed: String,
    /// `depositTotal - cumulativeClaimed + credited` (issue #700's netting:
    /// `credited` is what this connector has separately committed to pay
    /// this channel's counterparty back, e.g. for factory work it earned --
    /// `0` for a channel nothing has been paid out on). This is the same
    /// spendable headroom figure the collateral-binding check in
    /// `client-edge-spec.md` §1.3 step 5 admits an inbound claim against,
    /// not a raw on-chain balance -- an agent that has earned enough sees
    /// its own runway rise here without any settlement having happened.
    /// `null` exactly when `depositTotal` is, for the same reason.
    available: Option<String>,
    nonce: u64,
    /// Unix seconds this connector last accepted a claim on this channel,
    /// or `null` if it has not (or not since its own last restart -- see
    /// [`crate::ClientClaimGate`]'s `last_claim_seen` doc: this figure is
    /// best-effort and non-durable by design, unlike every other field
    /// here).
    last_claim_time: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UnverifiedChannelState {
    blockchain: &'static str,
    channel_id: String,
    ok: bool,
    /// `"expired"` or `"unverified"` -- see this module's own doc for why
    /// nothing more specific is ever reported.
    error: &'static str,
}

fn unverified(
    blockchain: &'static str,
    channel_id: String,
    error: &'static str,
) -> ChannelStateResult {
    ChannelStateResult::Unverified(UnverifiedChannelState {
        blockchain,
        channel_id,
        ok: false,
        error,
    })
}

pub(crate) async fn claim_state(
    State(state): State<Arc<ClientEdgeState>>,
    Json(request): Json<ClaimStateRequest>,
) -> Response {
    let now = now_unix();
    let mut results = Vec::with_capacity(request.channels.len());
    for entry in request.channels {
        results.push(resolve_channel_proof(&state, entry, now).await);
    }
    Json(ClaimStateResponse { channels: results }).into_response()
}

async fn resolve_channel_proof(
    state: &ClientEdgeState,
    entry: ChannelProofRequest,
    now: u64,
) -> ChannelStateResult {
    match entry {
        ChannelProofRequest::Evm {
            channel_id,
            expires,
            signature,
        } => resolve_evm(state, channel_id, expires, signature, now).await,
        ChannelProofRequest::Solana {
            channel_account,
            expires,
            signature,
        } => resolve_solana(state, channel_account, expires, signature, now).await,
    }
}

async fn resolve_evm(
    state: &ClientEdgeState,
    channel_id_text: String,
    expires: u64,
    signature_text: String,
    now: u64,
) -> ChannelStateResult {
    if expires <= now {
        return unverified("evm", channel_id_text, "expired");
    }
    let Some(channel_id) = decode_hex_bytes::<32>(&channel_id_text) else {
        return unverified("evm", channel_id_text, "unverified");
    };
    let Some(signature) = decode_hex_bytes::<65>(&signature_text) else {
        return unverified("evm", channel_id_text, "unverified");
    };

    let requester = format!("claim-state-challenge:{signature_text}");
    let lookup = state
        .claim_gate
        .channels()
        .evm(&channel_id, &requester)
        .await;
    let Ok(Some(channel)) = lookup else {
        return unverified("evm", channel_id_text, "unverified");
    };

    let challenge = EvmClaimStateChallenge {
        channel_id,
        expires,
        chain_id: channel.chain_id,
        token_network_address: channel.token_network_address,
    };
    if !verify_evm_claim_state_challenge(&challenge, &signature, &channel.counterparty) {
        return unverified("evm", channel_id_text, "unverified");
    }

    let channel_id_hex = format!("0x{}", hex_encode(&channel_id));
    let channel_key = format!("evm:{channel_id_hex}");
    ChannelStateResult::Verified(verified_state(
        "evm",
        channel_id_hex,
        state,
        &channel_key,
        channel.deposit_floor,
        state.claim_gate.credited_evm(&channel_id),
    ))
}

async fn resolve_solana(
    state: &ClientEdgeState,
    channel_account_text: String,
    expires: u64,
    signature_text: String,
    now: u64,
) -> ChannelStateResult {
    if expires <= now {
        return unverified("solana", channel_account_text, "expired");
    }
    let Some(channel_account) = decode_base58_bytes::<32>(&channel_account_text) else {
        return unverified("solana", channel_account_text, "unverified");
    };
    let Ok(signature) = BASE64.decode(&signature_text) else {
        return unverified("solana", channel_account_text, "unverified");
    };

    let requester = format!("claim-state-challenge:{signature_text}");
    let lookup = state
        .claim_gate
        .channels()
        .solana(&channel_account, &requester)
        .await;
    let Ok(Some(channel)) = lookup else {
        return unverified("solana", channel_account_text, "unverified");
    };

    if !verify_solana_claim_state_challenge(
        &channel_account,
        expires,
        &signature,
        &channel.counterparty,
    ) {
        return unverified("solana", channel_account_text, "unverified");
    }

    let channel_key = format!("solana:{channel_account_text}");
    ChannelStateResult::Verified(verified_state(
        "solana",
        channel_account_text,
        state,
        &channel_key,
        channel.deposit_floor,
        // `ClientPayoutLedger` only ever signs an EVM balance proof (issue
        // #699) -- a Solana channel has no credited amount to net yet, see
        // `ClientClaimGate::credited`'s own doc.
        0,
    ))
}

/// `deposit_total`, `cumulativeClaimed`, `nonce` and the netted
/// `available` this endpoint reports for one verified channel (issue
/// #700, `client-edge-spec.md` §1.10): `available` is the same spendable
/// headroom [`crate::claim_gate::ClientClaimGate`]'s collateral check
/// admits against -- `deposit - owed + credited`, `owed` being
/// `cumulative_claimed` below -- so a fleet dashboard reads one number
/// that already reflects an agent's own earnings, not a raw on-chain
/// balance a human would have to net by hand.
fn verified_state(
    blockchain: &'static str,
    channel_id: String,
    state: &ClientEdgeState,
    channel_key: &str,
    deposit_floor: DepositFloor,
    credited: u64,
) -> VerifiedChannelState {
    let watermark = state.claim_gate.watermark(channel_key);
    let cumulative_claimed = watermark.map(|w| w.cumulative_amount).unwrap_or(0);
    let nonce = watermark.map(|w| w.nonce).unwrap_or(0);
    let deposit_total = deposit_floor.deposit();
    let available = deposit_total.map(|deposit| {
        deposit
            .saturating_add(credited)
            .saturating_sub(cumulative_claimed)
    });

    VerifiedChannelState {
        blockchain,
        channel_id,
        ok: true,
        deposit_total: deposit_total.map(|amount| amount.to_string()),
        cumulative_claimed: cumulative_claimed.to_string(),
        available: available.map(|amount| amount.to_string()),
        nonce,
        last_claim_time: state.claim_gate.last_claim_time(channel_key),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use chrono::{TimeZone, Utc};
    use connector_domain::Prepare;
    use connector_runtime::{
        Connector, FakeAppClient, InMemoryJournal, InProcessPeerTransport, TestClock,
    };
    use connector_signer::{
        evm_claim_state_challenge_digest, solana_claim_state_challenge_message, LocalSigner, Signer,
    };
    use ed25519_dalek::Signer as Ed25519Signer;
    use libsecp256k1::{Message, PublicKey, SecretKey};
    use rand::SeedableRng;
    use tower::ServiceExt;

    use crate::channels::test_source::FakeChannelSource;
    use crate::{
        router_with_gate, ClientChannelRegistry, ClientClaimGate, ClientPayoutLedger, EvmChannel,
    };

    const EVM_CHAIN_ID: u64 = 8453;
    const EVM_TOKEN_NETWORK_ADDRESS: [u8; 20] = [0x42; 20];
    const EVM_CHANNEL_ID: [u8; 32] = [0xab; 32];
    const KNOWN_DEPOSIT: u64 = 1_000_000;
    const SOLANA_CHANNEL_ACCOUNT: [u8; 32] = [3u8; 32];

    fn evm_channel_id_hex() -> String {
        format!("0x{}", hex_encode(&EVM_CHANNEL_ID))
    }

    fn evm_signer() -> (SecretKey, connector_signer::Address) {
        let secret = SecretKey::parse(&[9u8; 32]).unwrap();
        let public = PublicKey::from_secret_key(&secret);
        (
            secret,
            connector_signer::derive_evm_address(&public.serialize()),
        )
    }

    fn sign_evm(secret: &SecretKey, digest: &[u8; 32]) -> Vec<u8> {
        let message = Message::parse(digest);
        let (signature, recovery_id) = libsecp256k1::sign(&message, secret);
        let mut bytes = signature.serialize().to_vec();
        let recovery_byte: u8 = recovery_id.into();
        bytes.push(recovery_byte + 27);
        bytes
    }

    fn evm_challenge_signature(secret: &SecretKey, channel_id: [u8; 32], expires: u64) -> String {
        let challenge = EvmClaimStateChallenge {
            channel_id,
            expires,
            chain_id: EVM_CHAIN_ID,
            token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
        };
        let digest = evm_claim_state_challenge_digest(&challenge);
        format!("0x{}", hex_encode(&sign_evm(secret, &digest)))
    }

    fn solana_signer() -> ed25519_dalek::Keypair {
        let mut rng = rand::rngs::StdRng::from_seed([13u8; 32]);
        ed25519_dalek::Keypair::generate(&mut rng)
    }

    fn base58_encode(bytes: &[u8]) -> String {
        bs58::encode(bytes).into_string()
    }

    fn solana_challenge_signature(keypair: &ed25519_dalek::Keypair, expires: u64) -> String {
        let message = solana_claim_state_challenge_message(&SOLANA_CHANNEL_ACCOUNT, expires);
        let signature = keypair.sign(&message);
        BASE64.encode(signature.to_bytes())
    }

    /// A registry with one EVM channel resolved (not declared) with a known
    /// deposit, via a [`FakeChannelSource`] -- `record_evm` alone always
    /// leaves [`DepositFloor::Unknown`] (a declared channel names no
    /// amount), so exercising `depositTotal`/`available` as real numbers
    /// needs the resolution path a `[settlement]`-backed node actually
    /// uses. Also declares one Solana channel with the usual "no deposit
    /// knowable" shape, for the tests that only care about the signature
    /// and watermark halves.
    fn test_channels() -> ClientChannelRegistry {
        let (_secret, address) = evm_signer();
        let source = FakeChannelSource::knowing(vec![(
            EVM_CHANNEL_ID,
            EvmChannel {
                counterparty: address,
                chain_id: EVM_CHAIN_ID,
                token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
                deposit_floor: DepositFloor::AtLeast(KNOWN_DEPOSIT),
            },
        )]);
        let mut channels = ClientChannelRegistry::new().with_source(Arc::new(source));
        channels
            .record_solana(
                &base58_encode(&SOLANA_CHANNEL_ACCOUNT),
                &base58_encode(&solana_signer().public.to_bytes()),
            )
            .expect("a 32-byte base58 channel account");
        channels
    }

    fn test_gate() -> ClientClaimGate {
        ClientClaimGate::restore(test_channels(), Arc::new(InMemoryJournal::new()))
            .expect("a fresh in-memory journal has nothing to replay")
    }

    fn test_signer() -> Arc<dyn Signer> {
        Arc::new(LocalSigner::generate("test-signer"))
    }

    fn test_connector() -> Arc<Connector> {
        Arc::new(Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            Arc::new(TestClock::new(
                Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
            )),
        ))
    }

    fn far_future_expiry() -> u64 {
        Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0)
            .unwrap()
            .timestamp() as u64
    }

    fn long_past_expiry() -> u64 {
        Utc.with_ymd_and_hms(2000, 1, 1, 0, 0, 0)
            .unwrap()
            .timestamp() as u64
    }

    async fn post_claim_state(gate: ClientClaimGate, body: serde_json::Value) -> serde_json::Value {
        let app = router_with_gate(test_connector(), test_signer(), None, gate);
        let request = Request::builder()
            .method("POST")
            .uri("/ilp/claim-state")
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        serde_json::from_slice(&bytes).expect("valid JSON response")
    }

    #[tokio::test]
    async fn a_verified_evm_channel_reports_deposit_cumulative_available_and_nonce() {
        let (secret, _address) = evm_signer();
        let expires = far_future_expiry();
        let body = serde_json::json!({
            "channels": [{
                "blockchain": "evm",
                "channelId": evm_channel_id_hex(),
                "expires": expires,
                "signature": evm_challenge_signature(&secret, EVM_CHANNEL_ID, expires),
            }]
        });

        let response = post_claim_state(test_gate(), body).await;
        let entry = &response["channels"][0];
        assert_eq!(entry["ok"], true);
        assert_eq!(entry["blockchain"], "evm");
        assert_eq!(entry["depositTotal"], KNOWN_DEPOSIT.to_string());
        assert_eq!(entry["cumulativeClaimed"], "0");
        assert_eq!(entry["available"], KNOWN_DEPOSIT.to_string());
        assert_eq!(entry["nonce"], 0);
        assert!(entry["lastClaimTime"].is_null());
    }

    /// A ledger crediting `channel_id` for `amount` -- the netting
    /// counterpart to the payments `test_channels`/`test_gate` already
    /// simulate on the inbound side (issue #700).
    fn payout_ledger_crediting(channel_id: &str, amount: u64) -> Arc<ClientPayoutLedger> {
        let mut ledger = ClientPayoutLedger::new();
        ledger.set_signer(Arc::new(LocalSigner::generate("payout-key")));
        ledger
            .set_channel_domain(
                channel_id,
                connector_runtime::ChannelDomain {
                    chain_id: EVM_CHAIN_ID,
                    token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
                },
            )
            .expect("test channel id is valid");
        let ledger = Arc::new(ledger);
        ledger
            .record_payout(
                channel_id,
                amount,
                Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
            )
            .expect("signer and domain configured");
        ledger
    }

    #[tokio::test]
    async fn a_channel_credited_by_the_payout_ledger_reports_available_raised_by_it() {
        let (secret, _address) = evm_signer();
        let ledger = payout_ledger_crediting(&evm_channel_id_hex(), 300_000);
        let gate = test_gate().with_payout_ledger(ledger);
        let expires = far_future_expiry();
        let body = serde_json::json!({
            "channels": [{
                "blockchain": "evm",
                "channelId": evm_channel_id_hex(),
                "expires": expires,
                "signature": evm_challenge_signature(&secret, EVM_CHANNEL_ID, expires),
            }]
        });

        let response = post_claim_state(gate, body).await;
        let entry = &response["channels"][0];
        assert_eq!(entry["ok"], true);
        assert_eq!(entry["depositTotal"], KNOWN_DEPOSIT.to_string());
        assert_eq!(entry["cumulativeClaimed"], "0");
        // deposit - owed(0) + credited: strictly more than the raw
        // on-chain deposit alone, which is the entire point of issue #700.
        assert_eq!(entry["available"], (KNOWN_DEPOSIT + 300_000).to_string());
    }

    #[tokio::test]
    async fn a_declared_solana_channel_reports_null_deposit_and_available() {
        let keypair = solana_signer();
        let expires = far_future_expiry();
        let body = serde_json::json!({
            "channels": [{
                "blockchain": "solana",
                "channelAccount": base58_encode(&SOLANA_CHANNEL_ACCOUNT),
                "expires": expires,
                "signature": solana_challenge_signature(&keypair, expires),
            }]
        });

        let response = post_claim_state(test_gate(), body).await;
        let entry = &response["channels"][0];
        assert_eq!(entry["ok"], true);
        assert_eq!(entry["blockchain"], "solana");
        assert!(entry["depositTotal"].is_null());
        assert_eq!(entry["cumulativeClaimed"], "0");
        assert!(entry["available"].is_null());
        assert_eq!(entry["nonce"], 0);
    }

    #[tokio::test]
    async fn a_wrong_signature_and_an_unknown_channel_report_the_identical_generic_error() {
        let expires = far_future_expiry();
        // A channel this registry knows about, but signed by the wrong key.
        let forger_secret = SecretKey::parse(&[42u8; 32]).unwrap();
        let wrong_signature = evm_challenge_signature(&forger_secret, EVM_CHANNEL_ID, expires);

        // A channel this registry has never heard of, with a well-formed
        // but meaningless signature.
        let unknown_channel_id = [0x99u8; 32];
        let unknown_channel_signature =
            evm_challenge_signature(&forger_secret, unknown_channel_id, expires);

        let body = serde_json::json!({
            "channels": [
                {
                    "blockchain": "evm",
                    "channelId": evm_channel_id_hex(),
                    "expires": expires,
                    "signature": wrong_signature,
                },
                {
                    "blockchain": "evm",
                    "channelId": format!("0x{}", hex_encode(&unknown_channel_id)),
                    "expires": expires,
                    "signature": unknown_channel_signature,
                },
            ]
        });

        let response = post_claim_state(test_gate(), body).await;
        for index in 0..2 {
            let entry = &response["channels"][index];
            assert_eq!(entry["ok"], false);
            assert_eq!(entry["error"], "unverified");
            // Confirms the two failures are byte-identical shapes -- a
            // caller cannot tell "wrong key" from "no such channel" apart.
            assert_eq!(entry.as_object().unwrap().len(), 4);
        }
    }

    #[tokio::test]
    async fn an_expired_challenge_is_refused_distinctly_from_an_unverified_one() {
        let (secret, _address) = evm_signer();
        let expires = long_past_expiry();
        let body = serde_json::json!({
            "channels": [{
                "blockchain": "evm",
                "channelId": evm_channel_id_hex(),
                "expires": expires,
                "signature": evm_challenge_signature(&secret, EVM_CHANNEL_ID, expires),
            }]
        });

        let response = post_claim_state(test_gate(), body).await;
        let entry = &response["channels"][0];
        assert_eq!(entry["ok"], false);
        assert_eq!(entry["error"], "expired");
    }

    #[tokio::test]
    async fn a_batch_of_several_channels_is_resolved_independently_and_in_order() {
        let (secret, _address) = evm_signer();
        let keypair = solana_signer();
        let expires = far_future_expiry();
        let forger_secret = SecretKey::parse(&[42u8; 32]).unwrap();

        let body = serde_json::json!({
            "channels": [
                {
                    "blockchain": "evm",
                    "channelId": evm_channel_id_hex(),
                    "expires": expires,
                    "signature": evm_challenge_signature(&secret, EVM_CHANNEL_ID, expires),
                },
                {
                    "blockchain": "solana",
                    "channelAccount": base58_encode(&SOLANA_CHANNEL_ACCOUNT),
                    "expires": expires,
                    "signature": solana_challenge_signature(&keypair, expires),
                },
                {
                    "blockchain": "evm",
                    "channelId": evm_channel_id_hex(),
                    "expires": expires,
                    "signature": evm_challenge_signature(&forger_secret, EVM_CHANNEL_ID, expires),
                },
            ]
        });

        let response = post_claim_state(test_gate(), body).await;
        let channels = response["channels"].as_array().unwrap();
        assert_eq!(channels.len(), 3);
        assert_eq!(channels[0]["ok"], true);
        assert_eq!(channels[0]["blockchain"], "evm");
        assert_eq!(channels[1]["ok"], true);
        assert_eq!(channels[1]["blockchain"], "solana");
        assert_eq!(channels[2]["ok"], false);
        assert_eq!(channels[2]["error"], "unverified");
    }

    #[tokio::test]
    async fn a_real_claim_updates_cumulative_claimed_nonce_and_last_claim_time() {
        let (secret, address) = evm_signer();
        let gate = test_gate();
        let balance_proof = connector_signer::EvmBalanceProof {
            channel_id: EVM_CHANNEL_ID,
            nonce: 1,
            transferred_amount: 500,
            locked_amount: 0,
            locks_root: [0u8; 32],
            chain_id: EVM_CHAIN_ID,
            token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
        };
        let balance_proof_digest = connector_signer::evm_balance_proof_digest(&balance_proof);
        let balance_proof_signature = format!(
            "0x{}",
            hex_encode(&sign_evm(&secret, &balance_proof_digest))
        );
        let claim_json = serde_json::json!({
            "version": "1.0",
            "blockchain": "evm",
            "messageId": "m1",
            "timestamp": "2030-01-01T00:00:00Z",
            "senderId": "sender",
            "channelId": evm_channel_id_hex(),
            "nonce": 1,
            "transferredAmount": "500",
            "lockedAmount": "0",
            "locksRoot": format!("0x{}", "0".repeat(64)),
            "signature": balance_proof_signature,
            "signerAddress": format!("0x{}", hex_encode(&address)),
            "chainId": EVM_CHAIN_ID,
            "tokenNetworkAddress": format!("0x{}", hex_encode(&EVM_TOKEN_NETWORK_ADDRESS)),
        })
        .to_string();

        let connector = test_connector();
        let signer = test_signer();
        let app = router_with_gate(Arc::clone(&connector), Arc::clone(&signer), None, gate);

        let prepare = Prepare {
            amount: 0,
            expires_at: Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap(),
            execution_condition: [0u8; 32],
            destination: "g.nowhere".to_string(),
            data: Vec::new(),
        };
        let request = Request::builder()
            .method("POST")
            .uri("/ilp")
            .header(crate::CLAIM_HEADER, BASE64.encode(claim_json))
            .body(Body::from(prepare.encode()))
            .unwrap();
        let before = now_unix();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let expires = far_future_expiry();
        let body = serde_json::json!({
            "channels": [{
                "blockchain": "evm",
                "channelId": evm_channel_id_hex(),
                "expires": expires,
                "signature": evm_challenge_signature(&secret, EVM_CHANNEL_ID, expires),
            }]
        });
        let request = Request::builder()
            .method("POST")
            .uri("/ilp/claim-state")
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let response: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

        let entry = &response["channels"][0];
        assert_eq!(entry["ok"], true);
        assert_eq!(entry["nonce"], 1);
        assert_eq!(entry["cumulativeClaimed"], "500");
        assert_eq!(entry["available"], (KNOWN_DEPOSIT - 500).to_string());
        let last_claim_time = entry["lastClaimTime"]
            .as_u64()
            .expect("a recorded claim time");
        assert!(last_claim_time >= before);
    }
}
