//! Issue #528: a paid write, proven end to end, against a real chain.
//!
//! Nothing before this file joined "money genuinely moved" to "the write
//! genuinely landed." Settlement was exercised against a real chain in
//! isolation (`connector-settlement-evm`'s own suite); the packet path was
//! exercised with fakes (`connector-client-edge`'s `price_charging_real_chain.rs`
//! uses an in-process `tower::Service` and a `FakeAppClient`); the one test
//! that drove the real binary (`two_connectors_and_a_stub_app.rs`) used a
//! zero-priced route and asserted delivery, never a claim.
//!
//! This test spawns a real `anvil` chain, deploys a real `TokenNetworkRegistry`/
//! `TokenNetwork`/mock ERC-20 onto it, mints and deposits real value into a
//! real channel, spawns a real compiled `connector` binary fronting a real
//! HTTP app (bound to its own socket, recording what it receives), and sends
//! a real sealed, claim-bearing packet over a real TCP connection to the
//! connector's client edge. It asserts the app's recorded write and the
//! claim's accepted value together, and that an underpaid claim reaches
//! neither.

use std::io::Write;
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use chrono::Duration as ChronoDuration;
use ed25519_dalek::Keypair;
use libsecp256k1::{Message, PublicKey, SecretKey};
use rand::rngs::OsRng;

use connector_domain::{EnvelopeResponse, Fulfill, Prepare, Reject};
use connector_operator::test_support::sign_request;
use connector_runtime::ChannelView;
use connector_settlement::SettlementBackend;
use connector_settlement_evm::test_support::{require_anvil, Anvil, DEPLOYER_PRIVATE_KEY};
use connector_settlement_evm::EvmSettlementBackend;
use connector_signer::giftwrap::open_response;
use connector_signer::{derive_evm_address, evm_balance_proof_digest, to_hex, EvmBalanceProof};

mod support;
use support::{
    identity_from_key_seed, sample_prepare, sealed_prepare_data, spawn_connector, write_config,
    write_raw_key_file,
};

/// `anvil`'s own default chain id (`Anvil::spawn`'s `--chain-id 31337`), and
/// so the EIP-712 domain a claim against its deployed `TokenNetwork` must be
/// signed under -- matching `connector-cli/tests/settlement_lifecycle.rs`'s
/// own constant of the same name and value.
const ANVIL_CHAIN_ID: u64 = 31_337;

const CLAIM_HEADER: &str = "ilp-payment-channel-claim";

/// This test binary's own base port for [`Anvil::spawn`] -- distinct from
/// every other test binary's base in this workspace (`connector-bin`'s own
/// `devnet_configs_load.rs` uses `18_500`; `connector-settlement-evm`'s
/// tests use `18_600`; `connector-cli`'s use `18_700`/`18_800`;
/// `connector-client-edge`'s `price_charging_real_chain.rs` uses `18_900`)
/// so concurrent binaries under `cargo test --workspace` don't contend for
/// the same port range.
const ANVIL_BASE_PORT: u16 = 19_000;

/// The route's price, in the same integer units the settlement backend
/// deposits/redeems in -- deliberately small so the "advances by exactly
/// the price" claim below is easy to read.
const ROUTE_PRICE: u128 = 100;

/// Sign `digest` exactly the way the production signing path does
/// (`connector_signer::crypto::sign_digest`): a 65-byte `r || s || v`
/// signature with `v` in libsecp256k1's raw `{0, 1}` range, not the
/// `{27, 28}` an EVM wallet would append. `EvmSettlementBackend` itself
/// normalizes that before submitting to `claimFromChannel` (issue #590),
/// and the client edge's own verification accepts either range -- signing
/// the wallet range here would exercise neither of those paths for real
/// (issue #594).
fn sign_evm(secret: &SecretKey, digest: &[u8; 32]) -> Vec<u8> {
    let message = Message::parse(digest);
    let (signature, recovery_id) = libsecp256k1::sign(&message, secret);
    let mut bytes = signature.serialize().to_vec();
    let recovery_byte: u8 = recovery_id.into();
    bytes.push(recovery_byte);
    bytes
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn channel_id_bytes(id: &str) -> [u8; 32] {
    let hex_digits = id.trim_start_matches("0x");
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex_digits[i * 2..i * 2 + 2], 16)
            .expect("channel id is 0x-prefixed 64-hex");
    }
    out
}

/// A genuinely EIP-712-signed EVM claim (issue #506/#544, #575) over the
/// real deployed `TokenNetwork`'s own chain id and address -- not arbitrary
/// constants -- so a reader can tell this claim actually refers to the
/// chain this test just funded a channel on. Returns the claim JSON
/// alongside the raw signature bytes, so a caller can also redeem the same
/// claim against the chain (issue #594) without re-deriving it.
fn evm_claim_json(
    secret: &SecretKey,
    channel_id_hex: &str,
    nonce: u64,
    transferred_amount: u128,
    token_network_address: [u8; 20],
) -> (String, Vec<u8>) {
    let public = PublicKey::from_secret_key(secret);
    let address = derive_evm_address(&public.serialize());

    let proof = EvmBalanceProof {
        channel_id: channel_id_bytes(channel_id_hex),
        nonce,
        transferred_amount,
        locked_amount: 0,
        locks_root: [0u8; 32],
        chain_id: ANVIL_CHAIN_ID,
        token_network_address,
    };
    let signature = sign_evm(secret, &evm_balance_proof_digest(&proof));

    let json = format!(
        r#"{{
            "version": "1.0",
            "blockchain": "evm",
            "messageId": "msg-{nonce}",
            "timestamp": "2026-02-02T12:00:00.000Z",
            "senderId": "buyer",
            "channelId": "{channel_id_hex}",
            "nonce": {nonce},
            "transferredAmount": "{transferred_amount}",
            "lockedAmount": "0",
            "locksRoot": "0x{zeros}",
            "signature": "0x{signature}",
            "signerAddress": "{address}",
            "chainId": {ANVIL_CHAIN_ID},
            "tokenNetworkAddress": "{token_network_address}"
        }}"#,
        zeros = "0".repeat(64),
        signature = hex_encode(&signature),
        address = to_hex(&address),
        token_network_address = to_hex(&token_network_address),
    );
    (json, signature)
}

/// A real, independently queryable app: a genuine `axum` HTTP server bound
/// to its own OS-assigned socket, reachable only over that socket (never
/// invoked in-process) -- so "the app recorded the write" and "the app
/// recorded nothing" are facts about a second real process boundary, not
/// trust in the packet's own echoed response.
async fn spawn_recording_app() -> (String, Arc<Mutex<Vec<Bytes>>>) {
    #[derive(Clone)]
    struct RecordingState {
        recorded: Arc<Mutex<Vec<Bytes>>>,
    }

    async fn record(State(state): State<RecordingState>, body: Bytes) -> StatusCode {
        state
            .recorded
            .lock()
            .expect("recorded-writes lock poisoned")
            .push(body);
        StatusCode::OK
    }

    let recorded = Arc::new(Mutex::new(Vec::new()));
    let state = RecordingState {
        recorded: recorded.clone(),
    };
    let router = Router::new().route("/", post(record)).with_state(state);

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind recording app");
    let addr = listener.local_addr().expect("recording app addr");
    tokio::spawn(async move {
        axum::Server::from_tcp(listener)
            .expect("axum server from tcp listener")
            .serve(router.into_make_service())
            .await
            .expect("recording app server");
    });

    (addr.to_string(), recorded)
}

/// POST a sealed `Prepare`, base64-carrying `claim` in the claim header, to
/// a real connector's client edge, and return the raw response body -- the
/// paid and underpaid cases below differ only in what they decode that body
/// as (`Fulfill` vs `Reject`).
async fn post_ilp_packet(
    client: &reqwest::Client,
    client_edge_addr: &str,
    claim: &str,
    prepare: &Prepare,
    expect_msg: &str,
) -> Bytes {
    let response = client
        .post(format!("http://{client_edge_addr}/ilp"))
        .header(CLAIM_HEADER, base64_encode(claim.as_bytes()))
        .body(prepare.encode())
        .send()
        .await
        .expect(expect_msg);
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    response.bytes().await.expect("response body")
}

#[tokio::test]
async fn a_paid_write_lands_on_the_app_with_the_claim_advanced_by_the_routes_price() {
    // AC5: fail loudly in CI when the chain this test needs is unavailable,
    // never silently skip and report success (issue #471's own policy).
    if !require_anvil() {
        return;
    }

    // AC1/AC6: a real local chain, a real registry-resolved `TokenNetwork`,
    // and tokens genuinely minted for this test -- never assumed pre-funded.
    let anvil = Anvil::spawn(ANVIL_BASE_PORT).await;
    let token =
        EvmSettlementBackend::deploy_mock_token(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
            .await
            .expect("mint a fresh mock ERC-20 for this test");
    let backend = EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
        .await
        .expect("deploy a TokenNetwork through a fresh registry");
    let token_network_address = backend.address().to_fixed_bytes();

    // The buyer: a real secp256k1 identity able to sign balance proofs
    // `TokenNetwork.claimFromChannel` would recover on chain -- not a mocked
    // signer, and not a placeholder identifier hashed into address shape
    // (issue #576 refuses exactly that).
    let buyer_secret = SecretKey::parse(&[21u8; 32]).expect("valid secret key");
    let buyer_public = PublicKey::from_secret_key(&buyer_secret);
    let buyer_address = derive_evm_address(&buyer_public.serialize());

    // A funded channel with real, on-chain-deposited value -- read back from
    // the chain's own receipt, never invented by this test.
    let paid_channel = backend
        .open(buyer_address.to_vec(), ChronoDuration::hours(1))
        .await
        .expect("open a real channel");
    let paid_state = backend
        .fund(&paid_channel, 10 * ROUTE_PRICE)
        .await
        .expect("fund the channel with real ERC-20 value");
    assert_eq!(
        paid_state.deposited,
        10 * ROUTE_PRICE,
        "a real transaction genuinely moved this value on chain"
    );

    // A second, separately funded channel that received real value below
    // the route's price -- proving the underpayment case is refused against
    // genuine on-chain funding too, not a synthetic shortfall.
    let underpaid_channel = backend
        .open(buyer_address.to_vec(), ChronoDuration::hours(1))
        .await
        .expect("open a second real channel");
    let underpaid_state = backend
        .fund(&underpaid_channel, ROUTE_PRICE / 2)
        .await
        .expect("fund the second channel with real ERC-20 value, less than the route's price");
    assert_eq!(underpaid_state.deposited, ROUTE_PRICE / 2);

    // A real app: its own socket, its own process-independent record of
    // what it received.
    let (app_addr, recorded) = spawn_recording_app().await;

    // A real, spawned, compiled `connector` binary -- started from a config
    // file, exactly as a deployment would be, fronting the app above at a
    // priced route. AC1: a real `[settlement]` section, connected to the
    // same registry/`TokenNetwork` this test just deployed and funded --
    // the connector's own value-moving side of the chain, not merely a
    // chain sitting next to it -- plus an `[operator]` section so the test
    // can redeem the accepted claim through the same surface a real
    // operator would use, never by reaching around the connector into the
    // settlement backend directly.
    let key_file = write_raw_key_file(9);
    let mut settlement_key_file = tempfile::NamedTempFile::new().expect("temp settlement key file");
    settlement_key_file
        .write_all(DEPLOYER_PRIVATE_KEY.as_bytes())
        .expect("write settlement key file");
    let write_keypair = Keypair::generate(&mut OsRng);
    let write_key_hex = hex_encode(&write_keypair.public.to_bytes());
    let registry_address = backend.registry_address();
    let config = write_config(&format!(
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{key_file}"

[operator]
bearer_token = "operator-secret"
write_keys = ["{write_key_hex}"]

[settlement]
chain = "evm"
rpc_url = "{rpc_url}"
contract_address = "{registry_address:?}"
token_address = "{token:?}"
decimals = 6

[settlement.key]
key_file = "{settlement_key_file}"

[[routes]]
prefix = "g.example.app"
handler_url = "http://{app_addr}"
price = {ROUTE_PRICE}
"#,
        key_file = key_file.path().display(),
        settlement_key_file = settlement_key_file.path().display(),
        rpc_url = anvil.rpc_url,
    ));
    let connector = spawn_connector(config.path());
    let connector_identity = identity_from_key_seed(9);

    let client = reqwest::Client::new();

    // AC2/AC3/AC6: a sealed, paid packet -- signed for exactly the route's
    // price, so a fulfilled response proves the claim's cumulative amount
    // advanced by exactly the price, never merely "some amount >= price."
    let (data, shared_secret) = sealed_prepare_data(b"paid write", &connector_identity);
    let prepare = sample_prepare("g.example.app", data, &shared_secret);
    let (claim, claim_signature) = evm_claim_json(
        &buyer_secret,
        &paid_channel.0,
        1,
        ROUTE_PRICE,
        token_network_address,
    );
    let body = post_ilp_packet(
        &client,
        &connector.client_edge_addr,
        &claim,
        &prepare,
        "POST /ilp: paid write",
    )
    .await;
    let fulfill =
        Fulfill::decode(&body).expect("a claim covering exactly the route's price fulfils");
    let opened = open_response(&shared_secret, &fulfill.data).expect("open sealed response");
    let response_envelope = EnvelopeResponse::decode(&opened).expect("decode envelope");
    assert_eq!(response_envelope.status, 200);

    // Both halves, asserted together (AC3): the app genuinely recorded the
    // write, over its own socket, independent of the packet's own echo.
    let after_paid = recorded.lock().expect("recorded lock").clone();
    assert_eq!(
        after_paid.len(),
        1,
        "the app recorded exactly one write for the fulfilled, correctly-priced packet"
    );
    assert_eq!(after_paid[0].as_ref(), b"paid write");

    // AC2/AC3: redeem that exact claim against the real chain, through the
    // connector's own operator surface -- not inferred from the fulfil, and
    // not a second, hand-built settlement backend reaching around the
    // connector under test. A signature `TokenNetwork.claimFromChannel`
    // would refuse to recover (e.g. against the wrong deposit) fails this
    // redeem for real; joining it to the same test as the fulfilled write
    // is what proves the accept decision and the on-chain value are the
    // same claim, not two coincidentally-matching half-proofs.
    let redeem_body = serde_json::to_vec(&serde_json::json!({
        "nonce": 1,
        "cumulative_amount": ROUTE_PRICE,
        "signature_hex": format!("0x{}", hex_encode(&claim_signature)),
    }))
    .expect("encode redeem body");
    let redeem_path = format!("/channels/{}/redeem", paid_channel.0);
    let (sig_input, sig, digest) = sign_request(
        &write_keypair,
        "POST",
        &redeem_path,
        &redeem_body,
        1_000,
        Some(9_999_999_999),
    );
    let response = client
        .post(format!(
            "http://{}{redeem_path}",
            connector.client_edge_addr
        ))
        .header("signature-input", sig_input)
        .header("signature", sig)
        .header("content-digest", digest)
        .body(redeem_body)
        .send()
        .await
        .expect("POST /channels/:id/redeem");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let redeemed: ChannelView = response.json().await.expect("decode ChannelView");
    assert_eq!(
        redeemed.redeemed, ROUTE_PRICE,
        "the claim's cumulative amount, read back from the chain through the operator \
         surface, advanced by exactly the route's price -- not inferred from the fulfil"
    );

    // AC4: an underpaid packet -- a fresh claim on a channel genuinely
    // funded with less than the route's price -- is refused, and the app
    // records nothing for it.
    let (underpaid_data, underpaid_secret) =
        sealed_prepare_data(b"underpaid write attempt", &connector_identity);
    let underpaid_prepare = sample_prepare("g.example.app", underpaid_data, &underpaid_secret);
    let (underpaid_claim, _) = evm_claim_json(
        &buyer_secret,
        &underpaid_channel.0,
        1,
        underpaid_state.deposited,
        token_network_address,
    );
    let body = post_ilp_packet(
        &client,
        &connector.client_edge_addr,
        &underpaid_claim,
        &underpaid_prepare,
        "POST /ilp: underpaid write",
    )
    .await;
    let reject = Reject::decode(&body).expect("decode reject");
    assert_eq!(reject.code.as_str(), "F03");

    let after_underpaid = recorded.lock().expect("recorded lock").clone();
    assert_eq!(
        after_underpaid.len(),
        1,
        "the underpaid packet never reached the app -- still exactly the one prior write"
    );
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    STANDARD.encode(bytes)
}
