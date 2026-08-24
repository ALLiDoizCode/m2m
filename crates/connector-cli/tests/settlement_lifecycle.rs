//! A channel opened, funded, redeemed and closed against a real chain,
//! entirely through the operator surface of a connector process started
//! from a config file (issue #542's last acceptance criterion). Unlike
//! `connector-operator`'s own `channel_lifecycle` tests, nothing here
//! constructs a `SettlementBackend` directly and hands it to a
//! hand-built `Connector` -- the config file's `[settlement]` section is
//! the only settlement backend this test ever names, and
//! `connector_cli::run` is what turns it into a working operator surface.

use std::io::Write;

use ed25519_dalek::Keypair;
use libsecp256k1::{Message, PublicKey, SecretKey};
use rand::rngs::OsRng;
use tower::ServiceExt;

use axum::body::Body;
use axum::http::{Request, StatusCode};

use connector_operator::test_support::sign_request;
use connector_runtime::{ChannelView, ChannelViewStatus};
use connector_settlement::SettlementBackend;
use connector_settlement_evm::test_support::{
    anvil_available, Anvil, COUNTERPARTY_PRIVATE_KEY, DEPLOYER_PRIVATE_KEY,
};
use connector_settlement_evm::EvmSettlementBackend;
use connector_signer::{derive_evm_address, evm_balance_proof_digest, to_hex, EvmBalanceProof};

/// `anvil`'s own default chain id (`Anvil::spawn`'s `--chain-id 31337`),
/// and so the EIP-712 domain a claim against its deployed `TokenNetwork`
/// must be signed under.
const ANVIL_CHAIN_ID: u64 = 31_337;

/// Sign `digest` exactly the way the production signing path does
/// (`connector_signer::crypto::sign_digest`): a 65-byte `r || s || v`
/// signature with `v` in libsecp256k1's raw `{0, 1}` range, not the
/// `{27, 28}` an EVM wallet would append. `EvmSettlementBackend` itself
/// normalizes that before submitting to `claimFromChannel` (issue #590) --
/// signing the wallet range here would paper over that normalization
/// never being exercised by this end-to-end test.
fn sign_evm(secret: &SecretKey, digest: &[u8; 32]) -> Vec<u8> {
    let message = Message::parse(digest);
    let (signature, recovery_id) = libsecp256k1::sign(&message, secret);
    let mut bytes = signature.serialize().to_vec();
    let recovery_byte: u8 = recovery_id.into();
    bytes.push(recovery_byte);
    bytes
}

/// The raw bytes of a `0x`-optional hex private key.
fn hex_bytes(hex: &str) -> Vec<u8> {
    let hex = hex.trim_start_matches("0x");
    (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("key is hex"))
        .collect()
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

/// This test binary's own base port for [`Anvil::spawn`] -- distinct from
/// other test binaries' bases (`connector-settlement-evm`'s own tests use
/// 18_600; `connector-bin`'s use 18_500; `connector-cli`'s own
/// `settlement_construction` unit tests use 18_700) so that binaries
/// running concurrently under `cargo test --workspace` don't contend for
/// the same port range.
const ANVIL_BASE_PORT: u16 = 18_800;

fn signed_post(keypair: &Keypair, path: &str, body: Vec<u8>) -> Request<Body> {
    let (sig_input, sig, digest) =
        sign_request(keypair, "POST", path, &body, 1_000, Some(9_999_999_999));
    Request::builder()
        .method("POST")
        .uri(path)
        .header("signature-input", sig_input)
        .header("signature", sig)
        .header("content-digest", digest)
        .body(Body::from(body))
        .unwrap()
}

async fn body_channel_view(response: axum::response::Response) -> ChannelView {
    let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

/// AC: "A channel is opened, funded, redeemed and closed against a real
/// chain through the operator surface of a connector process started
/// from a config file, with no backend injected by the test."
#[tokio::test]
async fn a_channel_lifecycle_reaches_a_real_chain_through_a_config_driven_node() {
    if !anvil_available() {
        eprintln!("skipping: `anvil` not found on PATH (install via https://getfoundry.sh)");
        return;
    }

    let anvil = Anvil::spawn(ANVIL_BASE_PORT).await;
    let token =
        EvmSettlementBackend::deploy_mock_token(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
            .await
            .expect("deploy mock USDC");
    let backend = EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
        .await
        .expect("deploy a TokenNetwork through a fresh registry");
    let registry_address = backend.registry_address();
    let token_network_address = backend.address();

    // The channel's counterparty must be a real address able to sign a
    // balance proof `TokenNetwork.claimFromChannel` recovers (issue #576)
    // -- and, as of issue #1118, one that can also make its own on-chain
    // deposit, since no node can make it for them. So it is anvil's second
    // genesis account: genesis-funded with ETH for its own gas, and a
    // different address from the node's, which two `EvmSettlementBackend`s
    // over one nonce sequence could not be.
    let counterparty_secret = SecretKey::parse_slice(&hex_bytes(COUNTERPARTY_PRIVATE_KEY))
        .expect("anvil's second dev key is a valid secp256k1 secret");
    let counterparty_public = PublicKey::from_secret_key(&counterparty_secret);
    let counterparty_address = derive_evm_address(&counterparty_public.serialize());

    // Mock USDC for the counterparty to deposit, minted before the node
    // starts: this write signs as the deployer, and once the node is
    // serving the deployer's nonce sequence belongs to the node alone.
    backend
        .mint_mock_tokens_to(counterparty_address.into(), 1_000_000)
        .await
        .expect("mint the counterparty something of its own to deposit");
    drop(backend);

    let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
    key_file
        .write_all(DEPLOYER_PRIVATE_KEY.as_bytes())
        .expect("write key file");

    let keypair = Keypair::generate(&mut OsRng);
    let write_key_hex = keypair
        .public
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();

    let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
    write!(
        config_file,
        r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{key_path}"

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
key_file = "{key_path}"
"#,
        key_path = key_file.path().display(),
        rpc_url = anvil.rpc_url,
    )
    .expect("write config file");

    let command = connector_cli::run(&[
        "connector".to_string(),
        config_file.path().display().to_string(),
    ])
    .await
    .expect("run: config-driven node with settlement configured");
    // A bare config path is still `serve` (issue #784's subcommand
    // boundary): the only other `Command` a run can produce is an announce
    // that has already finished, which no path argument can select.
    let connector_cli::Command::Serve(node) = command else {
        panic!("a config path must produce a servable node");
    };
    let app = node.router;

    // Open.
    let open_body = serde_json::to_vec(&serde_json::json!({
        "counterparty_hex": to_hex(&counterparty_address),
        "settlement_timeout_seconds": 3600,
    }))
    .unwrap();
    let response = app
        .clone()
        .oneshot(signed_post(&keypair, "/channels", open_body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let opened: ChannelView = body_channel_view(response).await;
    assert_eq!(opened.deposited, 0);

    // Fund.
    let fund_body = serde_json::to_vec(&serde_json::json!({ "amount": 1_000 })).unwrap();
    let fund_path = format!("/channels/{}/fund", opened.id);
    let response = app
        .clone()
        .oneshot(signed_post(&keypair, &fund_path, fund_body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let funded: ChannelView = body_channel_view(response).await;
    // `POST /channels/:id/fund` is a SELF-deposit (issue #1118): it raises
    // this node's own collateral and leaves the counterparty's side alone.
    // Before #1118 it credited the counterparty instead -- a delegate
    // deposit only `TokenNetwork` permits, which made the identical
    // endpoint an unconditional error on Solana. This assertion is the
    // behaviour change, stated at the surface an operator actually calls.
    assert_eq!(funded.own_deposited, 1_000);
    assert_eq!(funded.deposited, 0);

    // The counterparty's own deposit -- the side a claim they sign is
    // redeemed out of, and the one no write on this node can make. This is
    // the production shape, not a fixture shortcut: a second connector
    // bound to the same `TokenNetwork` under the *counterparty's* own key,
    // calling the same `fund` the node just called, which credits whichever
    // side is calling. Both sides of this channel are now collateralised by
    // the same port method, each for itself.
    let counterparty_backend = EvmSettlementBackend::connect(
        &anvil.rpc_url,
        COUNTERPARTY_PRIVATE_KEY,
        registry_address,
        token,
        6,
    )
    .await
    .expect("bind the counterparty's own identity to the same TokenNetwork");
    let counterparty_funded = counterparty_backend
        .fund(&connector_settlement::ChannelId(opened.id.clone()), 1_000)
        .await
        .expect("the counterparty deposits on their own side");
    // Read from the counterparty's point of view, so `own_deposited` is
    // theirs -- the mirror image of what the node saw a moment ago.
    assert_eq!(counterparty_funded.own_deposited, 1_000);
    assert_eq!(counterparty_funded.counterparty_deposited, 1_000);

    // Redeem: `TokenNetwork.claimFromChannel` verifies a real EIP-712
    // signature over the balance proof (issue #576), recovered against the
    // channel's counterparty -- a genuine claim, signed by the same key
    // that opened the channel as counterparty above, rather than an
    // arbitrary placeholder.
    let proof = EvmBalanceProof {
        channel_id: channel_id_bytes(&opened.id),
        nonce: 1,
        transferred_amount: 400,
        locked_amount: 0,
        locks_root: [0u8; 32],
        chain_id: ANVIL_CHAIN_ID,
        token_network_address: token_network_address.to_fixed_bytes(),
    };
    let signature = sign_evm(&counterparty_secret, &evm_balance_proof_digest(&proof));
    let signature_hex = format!(
        "0x{}",
        signature
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    let redeem_body = serde_json::to_vec(&serde_json::json!({
        "nonce": 1,
        "cumulative_amount": 400,
        "signature_hex": signature_hex,
    }))
    .unwrap();
    let redeem_path = format!("/channels/{}/redeem", opened.id);
    let response = app
        .clone()
        .oneshot(signed_post(&keypair, &redeem_path, redeem_body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let redeemed: ChannelView = body_channel_view(response).await;
    assert_eq!(redeemed.redeemed, 400);
    assert_eq!(redeemed.deposited, 1_000);
    assert_eq!(redeemed.own_deposited, 1_000);

    // Close.
    let close_path = format!("/channels/{}/close", opened.id);
    let response = app
        .clone()
        .oneshot(signed_post(&keypair, &close_path, Vec::new()))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let closed: ChannelView = body_channel_view(response).await;
    assert_eq!(closed.status, ChannelViewStatus::Closed);

    // Terminal: funding a closed channel is rejected, not silently accepted.
    let fund_again_body = serde_json::to_vec(&serde_json::json!({ "amount": 1 })).unwrap();
    let response = app
        .oneshot(signed_post(&keypair, &fund_path, fund_again_body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}
