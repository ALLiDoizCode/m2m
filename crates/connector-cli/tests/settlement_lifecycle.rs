//! A channel opened, funded, redeemed and closed against a real chain,
//! entirely through the operator surface of a connector process started
//! from a config file (issue #542's last acceptance criterion). Unlike
//! `connector-operator`'s own `channel_lifecycle` tests, nothing here
//! constructs a `SettlementBackend` directly and hands it to a
//! hand-built `Connector` -- the config file's `[settlement]` section is
//! the only settlement backend this test ever names, and
//! `connector_cli::run` is what turns it into a working operator surface.

use std::io::Write;
use std::process::{Child, Command, Stdio};

use ed25519_dalek::Keypair;
use rand::rngs::OsRng;
use tower::ServiceExt;

use axum::body::Body;
use axum::http::{Request, StatusCode};

use connector_operator::test_support::sign_request;
use connector_runtime::{ChannelView, ChannelViewStatus};
use connector_settlement_evm::EvmSettlementBackend;

const DEPLOYER_PRIVATE_KEY: &str =
    "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

fn anvil_available() -> bool {
    Command::new("anvil")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

struct Anvil {
    child: Child,
    rpc_url: String,
}

impl Anvil {
    async fn spawn() -> Self {
        let port = 18_800u16.wrapping_add((std::process::id() as u16) % 1_000);
        let rpc_url = format!("http://127.0.0.1:{port}");
        let child = Command::new("anvil")
            .args(["--host", "127.0.0.1", "--port"])
            .arg(port.to_string())
            .args([
                "--chain-id",
                "31337",
                "--accounts",
                "1",
                "--balance",
                "10000",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn anvil (is `anvil` on PATH? see foundryup)");

        use ethers::providers::{Http, Middleware, Provider};
        let provider = Provider::<Http>::try_from(rpc_url.as_str()).expect("build provider");
        for _ in 0..200 {
            if provider.get_chainid().await.is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        Self { child, rpc_url }
    }
}

impl Drop for Anvil {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

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

    let anvil = Anvil::spawn().await;
    let token =
        EvmSettlementBackend::deploy_mock_token(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
            .await
            .expect("deploy mock USDC");
    let contract = EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
        .await
        .expect("deploy SettlementChannel");
    let contract_address = contract.address();
    drop(contract);

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
contract_address = "{contract_address:?}"
token_address = "{token:?}"
decimals = 6

[settlement.key]
key_file = "{key_path}"
"#,
        key_path = key_file.path().display(),
        rpc_url = anvil.rpc_url,
    )
    .expect("write config file");

    let node = connector_cli::run(&[
        "connector".to_string(),
        config_file.path().display().to_string(),
    ])
    .await
    .expect("run: config-driven node with settlement configured");
    let app = node.router;

    // Open.
    let open_body = serde_json::to_vec(&serde_json::json!({
        "counterparty_hex": "0x000000000000000000000000000000000000aa",
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
    assert_eq!(funded.deposited, 1_000);

    // Redeem: the contract stores a claim's signature only as an opaque
    // audit trail (crates/connector-settlement-evm/contracts/SettlementChannel.sol's
    // own doc comment) -- any bytes satisfy it here.
    let redeem_body = serde_json::to_vec(&serde_json::json!({
        "cumulative_amount": 400,
        "signature_hex": "0x09",
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
