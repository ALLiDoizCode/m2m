//! Real-chain proof for issue #522 ("charge the price"): a claim's value
//! is checked against genuine, on-chain-funded value -- never a synthetic
//! literal invented by the test -- and pay-to-write is absolute, with no
//! configuration, flag or build profile that disables it.
//!
//! Per ADR 0007, the value-binding rule itself (`connector_domain::validate_price`)
//! is pure and already covered by property tests in `connector-domain` and
//! by HTTP-seam unit tests in this crate's own `src/lib.rs`; a chain is not
//! genuinely involved in that logic. What a chain-backed test proves that
//! those cannot is that the number this connector charges against is one a
//! real settlement backend actually moved on a real (if disposable) chain
//! -- an `anvil` instance, opened and funded via `EvmSettlementBackend`
//! (issue #459) -- rather than a number this test merely wrote down.

mod support;

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{Duration, TimeZone, Utc};
use tower::ServiceExt;

use libsecp256k1::{Message, PublicKey, SecretKey};

use connector_client_edge::router;
use connector_config::StaticRoute;
use connector_domain::{
    derive_condition, EnvelopeRequest, EnvelopeResponse, Fulfill, Prepare, Reject,
};
use connector_runtime::{AppOutcome, Connector, FakeAppClient, InProcessPeerTransport, TestClock};
use connector_settlement::SettlementBackend;
use connector_settlement_evm::EvmSettlementBackend;
use connector_signer::{
    derive_evm_address, evm_balance_proof_digest, to_hex, EvmBalanceProof, LocalSigner, Signer,
};

use support::{require_anvil, Anvil, DEPLOYER_PRIVATE_KEY};

const FULFILLMENT: [u8; 32] = [7u8; 32];
const HANDLER_URL: &str = "http://localhost:4000";
const CLAIM_HEADER: &str = "ilp-payment-channel-claim";
const CHAIN_ID: u64 = 8453;
const TOKEN_NETWORK_ADDRESS: [u8; 20] = [0x42; 20];

fn test_clock() -> Arc<TestClock> {
    Arc::new(TestClock::new(
        Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
    ))
}

fn sample_prepare() -> Prepare {
    Prepare {
        amount: 0,
        expires_at: Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap(),
        execution_condition: derive_condition(&FULFILLMENT),
        destination: "g.example.app".to_string(),
        // Per ADR 0018/issue #519 a `Prepare`'s `data` carries a structured
        // envelope, decoded above the `AppClient` boundary (issue #521).
        data: EnvelopeRequest {
            method: "POST".to_string(),
            target: "/".to_string(),
            headers: vec![],
            body: b"hello app".to_vec(),
        }
        .encode(),
    }
}

/// The on-chain channel id `EvmSettlementBackend::open` returns is a
/// decimal counter -- reformatted here as the 0x-prefixed 64-char hex
/// `client_claim.rs` requires of an EVM claim's `channelId`.
fn channel_id_hex(id: &str) -> String {
    let n: u128 = id.parse().expect("channel id is a decimal integer");
    format!("0x{n:064x}")
}

/// Sign `digest` exactly the way a real EVM wallet would (a 65-byte
/// `r || s || v` signature, `v` in the conventional `{27, 28}` range).
fn sign_evm(secret: &SecretKey, digest: &[u8; 32]) -> Vec<u8> {
    let message = Message::parse(digest);
    let (signature, recovery_id) = libsecp256k1::sign(&message, secret);
    let mut bytes = signature.serialize().to_vec();
    let recovery_byte: u8 = recovery_id.into();
    bytes.push(recovery_byte + 27);
    bytes
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// An EVM claim JSON with a genuine EIP-712 signature over its own fields
/// (issue #506/#544) -- a forged or unsigned claim would be refused before
/// ever reaching the price check this file exists to prove.
fn evm_claim_json(channel_id_hex: &str, nonce: u64, transferred_amount: u128) -> String {
    let secret = SecretKey::parse(&[9u8; 32]).unwrap();
    let public = PublicKey::from_secret_key(&secret);
    let address = derive_evm_address(&public.serialize());

    let mut channel_id = [0u8; 32];
    channel_id.copy_from_slice(
        &hex::decode(channel_id_hex.trim_start_matches("0x")).expect("valid hex channel id"),
    );
    let proof = EvmBalanceProof {
        channel_id,
        nonce,
        transferred_amount,
        locked_amount: 0,
        locks_root: [0u8; 32],
        chain_id: CHAIN_ID,
        token_network_address: TOKEN_NETWORK_ADDRESS,
    };
    let signature = sign_evm(&secret, &evm_balance_proof_digest(&proof));

    format!(
        r#"{{
            "version": "1.0",
            "blockchain": "evm",
            "messageId": "msg-{nonce}",
            "timestamp": "2026-02-02T12:00:00.000Z",
            "senderId": "peer-bob",
            "channelId": "{channel_id_hex}",
            "nonce": {nonce},
            "transferredAmount": "{transferred_amount}",
            "lockedAmount": "0",
            "locksRoot": "0x{zeros}",
            "signature": "0x{signature}",
            "signerAddress": "{address}",
            "chainId": {CHAIN_ID},
            "tokenNetworkAddress": "{token_network_address}"
        }}"#,
        zeros = "0".repeat(64),
        signature = hex_encode(&signature),
        address = to_hex(&address),
        token_network_address = to_hex(&TOKEN_NETWORK_ADDRESS),
    )
}

fn deliverable_connector(route: StaticRoute, app_client: Arc<FakeAppClient>) -> Arc<Connector> {
    app_client.respond(
        route.handler_url(),
        AppOutcome::Answered {
            response: EnvelopeResponse {
                status: 200,
                headers: vec![(
                    "TOON-Fulfillment".to_string(),
                    FULFILLMENT
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect(),
                )],
                body: b"ok".to_vec(),
            },
        },
    );
    Arc::new(Connector::new(
        vec![route],
        vec![],
        app_client,
        Arc::new(InProcessPeerTransport::new()),
        test_clock(),
    ))
}

fn test_signer() -> Arc<dyn Signer> {
    Arc::new(LocalSigner::generate("test-signer"))
}

async fn post_claim(connector: Arc<Connector>, claim_json: &str) -> (StatusCode, Bytes) {
    let app = router(connector, test_signer());
    let request = Request::builder()
        .method("POST")
        .uri("/ilp")
        .header(CLAIM_HEADER, BASE64.encode(claim_json.as_bytes()))
        .body(Body::from(sample_prepare().encode()))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
    (status, bytes)
}

#[tokio::test]
async fn a_claim_backed_by_real_on_chain_funding_is_charged_the_routes_price() {
    if !require_anvil() {
        return;
    }

    let anvil = Anvil::spawn().await;
    let token =
        EvmSettlementBackend::deploy_mock_token(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
            .await
            .expect("deploy mock USDC");
    let backend = EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
        .await
        .expect("deploy SettlementChannel");

    // A channel genuinely opened and funded with real (anvil-minted mock
    // USDC) value -- `deposited` below is read back from the chain's own
    // receipt, never a number this test invents.
    let counterparty = b"pay-to-write-counterparty".to_vec();
    let paid_channel = backend
        .open(counterparty.clone(), Duration::hours(1))
        .await
        .expect("open a real channel");
    let paid_state = backend
        .fund(&paid_channel, 1_000)
        .await
        .expect("fund the channel with real ERC-20 value");
    assert_eq!(
        paid_state.deposited, 1_000,
        "a real transaction genuinely moved this value on chain"
    );

    let underpaid_channel = backend
        .open(counterparty, Duration::hours(1))
        .await
        .expect("open a second real channel");
    let underpaid_state = backend
        .fund(&underpaid_channel, 40)
        .await
        .expect("fund the second channel with real ERC-20 value, less than the route's price");
    assert_eq!(underpaid_state.deposited, 40);

    let route = StaticRoute::new_priced("g.example.app", HANDLER_URL, 100).unwrap();

    // A claim advancing by the full, genuinely-deposited 1_000 covers this
    // route's price of 100 and the packet is delivered (AC1).
    let app_client = Arc::new(FakeAppClient::new());
    let connector = deliverable_connector(route.clone(), app_client.clone());
    let (status, bytes) = post_claim(
        connector,
        &evm_claim_json(&channel_id_hex(&paid_channel.0), 1, paid_state.deposited),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    Fulfill::decode(&bytes).expect("a claim covering the real on-chain deposit is fulfilled");
    assert_eq!(app_client.deliveries().len(), 1);

    // A second, freshly funded channel that genuinely received only 40 --
    // less than the route's price of 100 -- is refused as underpayment
    // (F03), never reaching the app, with no flag or config to bypass it
    // (AC2, AC4).
    let app_client_two = Arc::new(FakeAppClient::new());
    let connector_two = deliverable_connector(route, app_client_two.clone());
    let (status_two, bytes_two) = post_claim(
        connector_two,
        &evm_claim_json(
            &channel_id_hex(&underpaid_channel.0),
            1,
            underpaid_state.deposited,
        ),
    )
    .await;
    assert_eq!(status_two, StatusCode::OK);
    let reject = Reject::decode(&bytes_two).expect("decode reject");
    assert_eq!(reject.code.as_str(), "F03");
    assert!(app_client_two.deliveries().is_empty());
}
