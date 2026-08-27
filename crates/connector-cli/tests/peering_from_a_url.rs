//! **A peering established from a URL, against a real chain** (ADR 0058,
//! issue #1160).
//!
//! Nothing here injects a settlement backend or hands the node a
//! pre-opened channel. A config-driven `connector_cli::run` node is given
//! one authenticated write -- `POST /peers { id, url, fee,
//! max_packet_amount }` -- pointed at a real HTTP server answering a real
//! self-description, and everything else is read off the document or off
//! anvil: the endpoint, the edge identity, the counterparty's settlement
//! address, and the channel derived from it.
//!
//! The three claims this file exists to hold:
//!
//! 1. **The channel derives from the settlement address of the chain in
//!    question, never from the edge identity.** Asserted against the chain
//!    itself -- `TokenNetwork.channels(id)` reports both participants, and
//!    they are the two nodes' settlement addresses. `claimFromChannel`
//!    recovers a balance proof's signer and requires it to *be* a
//!    participant, so a channel derived from a secp256k1 edge key would
//!    name a participant no chain holds and every claim on it would be
//!    unredeemable.
//! 2. **The endpoint is safely retryable.** It spends gas, so a repeat of
//!    the same request must find the channel the first opened rather than
//!    open a second. ADR 0059's derivation makes that structural, and the
//!    answer says which branch it took.
//! 3. **Trust-on-first-use.** Whatever the URL serves is who the peering
//!    is with. The document below is served by this test, is signed by
//!    nobody, and is checked against nothing the operator supplied --
//!    which is the property ADR 0058 states plainly and declines to
//!    strengthen.

use std::io::Write;
use std::net::SocketAddr;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use ed25519_dalek::Keypair;
use libsecp256k1::{PublicKey, SecretKey};
use rand::rngs::OsRng;
use tower::ServiceExt;

use connector_domain::x402::{X402ChainSettlementTerms, X402SettlementTerms};
use connector_domain::{EdgeIdentity, NodeFacts, NodeSelfDescription};
use connector_operator::test_support::sign_request;
use connector_runtime::PeerView;
use connector_settlement_evm::test_support::{
    require_anvil, Anvil, COUNTERPARTY_PRIVATE_KEY, DEPLOYER_PRIVATE_KEY,
};
use connector_settlement_evm::EvmSettlementBackend;
use connector_signer::{derive_evm_address, to_hex};

/// `anvil`'s own default chain id (`Anvil::spawn`'s `--chain-id 31337`),
/// and so what the served document must publish as `evm:<chainId>` for the
/// peering's claims to be signed under a domain that verifies.
const ANVIL_CHAIN_ID: u64 = 31_337;

/// This test binary's own base port for [`Anvil::spawn`]. Every other test
/// binary that spawns one has its own base (`connector-bin` 18_500,
/// `connector-settlement-evm` 18_600, `connector-cli`'s unit tests 18_700,
/// `settlement_lifecycle` 18_800, `connector-client-edge` 18_900), so
/// binaries running concurrently under `cargo test --workspace` never
/// contend for a port.
const ANVIL_BASE_PORT: u16 = 19_000;

/// A distinct `created` per signed request: the operator surface rejects a
/// replayed signature (ADR 0008's #1067 amendment), and the *point* of two
/// of the writes below is that they are byte-identical.
static NEXT_CREATED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(2_000);

fn signed(keypair: &Keypair, method: Method, path: &str, body: Vec<u8>) -> Request<Body> {
    let created = NEXT_CREATED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (sig_input, sig, digest) = sign_request(
        keypair,
        method.as_str(),
        path,
        &body,
        created,
        Some(9_999_999_999),
    );
    Request::builder()
        .method(method)
        .uri(path)
        .header("signature-input", sig_input)
        .header("signature", sig)
        .header("content-digest", digest)
        .body(Body::from(body))
        .unwrap()
}

/// The raw bytes of a `0x`-optional hex private key.
fn hex_bytes(hex: &str) -> Vec<u8> {
    let hex = hex.trim_start_matches("0x");
    (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("key is hex"))
        .collect()
}

fn address_of(private_key: &str) -> [u8; 20] {
    let secret = SecretKey::parse_slice(&hex_bytes(private_key))
        .expect("an anvil dev key is a valid secret");
    derive_evm_address(&PublicKey::from_secret_key(&secret).serialize())
}

fn channel_id_bytes(id: &str) -> [u8; 32] {
    let hex = id.trim_start_matches("0x");
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .expect("a channel id is 0x-prefixed 64-hex");
    }
    out
}

/// A **real** self-description on a **real** socket, exactly as ADR 0050
/// says a connector answers a `GET` on its own URL with.
///
/// Nothing signs it and nothing vouches for it. That is the record's own
/// position: whoever answers the URL the operator named is who the peering
/// is with, and the operator's vetting of the URL is the whole of the
/// assurance.
fn serve_self_description(
    settlement_address: [u8; 20],
    token_network: [u8; 20],
    registry: [u8; 20],
    token: [u8; 20],
) -> SocketAddr {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    let document = NodeSelfDescription::describe(
        &NodeFacts {
            ilp_addresses: vec!["g.example.counterparty".to_string()],
            // The peering's endpoint *and* the counterparty's client edge:
            // on ILP-over-HTTP they are the same URL, which is what every
            // `local/` topology already writes twice by hand.
            http_endpoint: Some(format!("http://{addr}/ilp")),
            btp_endpoint: None,
            peer_carriages: vec!["http".to_string()],
            settlements: vec![X402ChainSettlementTerms::Evm(X402SettlementTerms {
                chain: format!("evm:{ANVIL_CHAIN_ID}"),
                settlement_address: to_hex(&settlement_address),
                token_network_registry: to_hex(&registry),
                token_network: to_hex(&token_network),
                token_address: to_hex(&token),
                decimals: 6,
            })],
        },
        // A secp256k1 edge identity, deliberately a different value from
        // the settlement address above: the two are not interchangeable,
        // and a build that confused them would derive the channel here.
        Some(EdgeIdentity {
            key_id: "counterparty-edge-key".to_string(),
            public_key: "0x04".to_string() + &"cd".repeat(64),
        }),
        Vec::new(),
        None,
    );
    let app = Router::new().route(
        "/ilp",
        get(move || {
            let document = document.clone();
            async move { Json(document) }
        }),
    );
    tokio::spawn(async move {
        let _ = axum::Server::from_tcp(listener)
            .expect("serve the bound listener")
            .serve(app.into_make_service())
            .await;
    });
    addr
}

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
    serde_json::from_slice(&bytes).expect("a JSON body")
}

#[tokio::test]
async fn one_operator_write_establishes_a_peering_and_repeating_it_finds_the_same_channel() {
    // `require_anvil`, not a bare availability check: a guard that returns
    // early and reports `passed` in CI is worse than a missing test. It
    // panics when `CI` is set and skips only on a developer machine
    // without Foundry.
    if !require_anvil() {
        return;
    }

    let anvil = Anvil::spawn(ANVIL_BASE_PORT).await;
    let token =
        EvmSettlementBackend::deploy_mock_token(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
            .await
            .expect("deploy mock USDC");
    let deployed = EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
        .await
        .expect("deploy a TokenNetwork through a fresh registry");
    let registry_address = deployed.registry_address();
    let token_network_address = deployed.address();
    drop(deployed);

    // The node settles as anvil's first genesis account; the counterparty
    // it is about to peer with is the second. Two real addresses, each able
    // to sign a balance proof `claimFromChannel` recovers -- which is what
    // makes "the channel derives from the settlement address" a claim with
    // consequences rather than a naming preference.
    let node_settlement = address_of(DEPLOYER_PRIVATE_KEY);
    let counterparty_settlement = address_of(COUNTERPARTY_PRIVATE_KEY);
    assert_ne!(node_settlement, counterparty_settlement);

    let peer_addr = serve_self_description(
        counterparty_settlement,
        token_network_address.into(),
        registry_address.into(),
        token.into(),
    );

    let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
    key_file
        .write_all(DEPLOYER_PRIVATE_KEY.as_bytes())
        .expect("write key file");
    let state_dir = tempfile::tempdir().expect("temp state dir");

    let keypair = Keypair::generate(&mut OsRng);
    let write_key_hex = keypair
        .public
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();

    // A node with **no `[[peers]]` table at all**: every peering below is
    // established over the operator surface, which is the whole of what
    // ADR 0058 adds. `peer_allow_plaintext_endpoints` is the same opt-in
    // every `local/` topology takes -- there is no TLS terminator in front
    // of a loopback socket.
    let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
    write!(
        config_file,
        r#"
client_edge_addr = "127.0.0.1:0"
state_dir = "{state_dir}"
peer_allow_plaintext_endpoints = true

[signer]
key_file = "{key_path}"

[operator]
bearer_token = "operator-secret"
write_keys = ["{write_key_hex}"]

[settlement.evm]
rpc_url = "{rpc_url}"
contract_address = "{registry_address:?}"
token_address = "{token:?}"
decimals = 6

[settlement.evm.key]
key_file = "{key_path}"
"#,
        state_dir = state_dir.path().display(),
        key_path = key_file.path().display(),
        rpc_url = anvil.rpc_url,
    )
    .expect("write config file");

    let command = connector_cli::run(&[
        "connector".to_string(),
        config_file.path().display().to_string(),
    ])
    .await
    .expect("run: a config-driven node with EVM settlement and no peering");
    let connector_cli::Command::Serve(node) = command else {
        panic!("a config path must produce a servable node");
    };
    let app = node.router;

    let peer_body = serde_json::to_vec(&serde_json::json!({
        "id": "apex-relay-2",
        "url": format!("http://{peer_addr}/ilp"),
        "fee": 100,
        "max_packet_amount": 5_000,
    }))
    .unwrap();

    // ── The write ────────────────────────────────────────────────────────
    let response = app
        .clone()
        .oneshot(signed(&keypair, Method::POST, "/peers", peer_body.clone()))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let established = body_json(response).await;

    assert_eq!(established["id"], "apex-relay-2");
    assert_eq!(established["source"], "runtime");
    // The operator's own policy, read back: the fee this hop retains and
    // the cap it enforces (ADR 0049, ADR 0061). Neither could come from
    // the document, which is why both are in the request.
    assert_eq!(established["fee"], 100);
    assert_eq!(established["max_packet_amount"], 5_000);
    // No channel existed for this pair, so the write opened one and waited
    // for it. The branch is in the answer so an unintended second channel
    // is visible here rather than on a block explorer later.
    assert_eq!(established["channel"]["status"], "created");
    assert_eq!(established["channel"]["chain"], "evm");
    let channel_id = established["channel"]["id"]
        .as_str()
        .expect("the channel's id")
        .to_string();

    // ── The channel is the two SETTLEMENT addresses' ────────────────────
    // Read off the chain, not off the answer: `TokenNetwork.channels(id)`
    // carries both participants, and a channel derived from anything but
    // the settlement addresses would name someone else here.
    let reader = EvmSettlementBackend::connect(
        &anvil.rpc_url,
        COUNTERPARTY_PRIVATE_KEY,
        registry_address,
        token,
        6,
    )
    .await
    .expect("a second backend under the counterparty's own key");
    let counterparty_view = reader
        .channel_counterparty(channel_id_bytes(&channel_id))
        .await
        .expect("read the channel back off the chain")
        .expect("the channel exists and this backend is a participant");
    assert_eq!(
        <[u8; 20]>::from(counterparty_view),
        node_settlement,
        "seen from the counterparty's side, the other participant is the node's SETTLEMENT \
         address -- never its edge identity, which is a secp256k1 key on the client edge and \
         could not be a TokenNetwork participant at all"
    );

    // ...and it is the id ADR 0059's derivation names, computed here from
    // the two participants alone with no help from the answer above.
    let derived = reader
        .channel_with(node_settlement.into())
        .await
        .expect("ask the chain whether this pair has a channel")
        .expect("it does");
    assert_eq!(derived.0, channel_id);

    // ── Repeating the identical request finds it ────────────────────────
    let response = app
        .clone()
        .oneshot(signed(&keypair, Method::POST, "/peers", peer_body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let repeated = body_json(response).await;
    assert_eq!(
        repeated["channel"]["status"], "found",
        "a repeat must land on the channel the first attempt opened"
    );
    assert_eq!(repeated["channel"]["id"], channel_id.as_str());

    // The chain agrees that there is still exactly one: the pair's epoch
    // has not moved, so their current derived id is still this channel's.
    let still = reader
        .channel_with(node_settlement.into())
        .await
        .expect("ask again")
        .expect("still one");
    assert_eq!(
        still.0, channel_id,
        "a retry must not open a second channel"
    );

    // ── The peering is one row, readable back ───────────────────────────
    let read = Request::builder()
        .method(Method::GET)
        .uri("/peers")
        .header("authorization", "Bearer operator-secret")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(read).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
    let peers: Vec<PeerView> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(peers.len(), 1, "one write, one peering: {peers:?}");
    assert_eq!(peers[0].id, "apex-relay-2");
    assert_eq!(peers[0].fee, 100);
    assert_eq!(peers[0].max_packet_amount, 5_000);

    // ── A route through it is now a second, separate write ──────────────
    // ADR 0058: "onboarding becomes three calls, and two of them already
    // exist". The route is accepted because the peering it names has a
    // channel to pay from -- the runtime twin of ADR 0042's load rule.
    let route_body = serde_json::to_vec(&serde_json::json!({
        "prefix": "g.example.counterparty",
        "peer_id": "apex-relay-2",
        "price": 1_100,
    }))
    .unwrap();
    let response = app
        .clone()
        .oneshot(signed(&keypair, Method::POST, "/routes/peers", route_body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

/// The document is taken as served, and nothing in the request is compared
/// against it.
///
/// A **second** node, given a document that publishes a *different*
/// counterparty at the same URL, establishes a peering with that
/// counterparty instead -- no refusal, no warning, and a channel opened
/// against whoever the URL said. That is trust-on-first-use, and it is
/// asserted here so a later change that quietly adds a pin, a fingerprint
/// or a confirmation step fails a test rather than passing one.
#[tokio::test]
async fn whatever_the_url_serves_is_who_the_peering_is_with() {
    if !require_anvil() {
        return;
    }

    let anvil = Anvil::spawn(ANVIL_BASE_PORT + 10).await;
    let token =
        EvmSettlementBackend::deploy_mock_token(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
            .await
            .expect("deploy mock USDC");
    let deployed = EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
        .await
        .expect("deploy a TokenNetwork through a fresh registry");
    let registry_address = deployed.registry_address();
    let token_network_address = deployed.address();
    drop(deployed);

    // Not an anvil dev key at all -- an address nobody in this test holds
    // a key for. The node has no way to tell, and does not try: it opens a
    // channel against whoever the document named.
    let stranger = [0x5au8; 20];
    let peer_addr = serve_self_description(
        stranger,
        token_network_address.into(),
        registry_address.into(),
        token.into(),
    );

    let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
    key_file
        .write_all(DEPLOYER_PRIVATE_KEY.as_bytes())
        .expect("write key file");
    let state_dir = tempfile::tempdir().expect("temp state dir");
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
state_dir = "{state_dir}"
peer_allow_plaintext_endpoints = true

[signer]
key_file = "{key_path}"

[operator]
bearer_token = "operator-secret"
write_keys = ["{write_key_hex}"]

[settlement.evm]
rpc_url = "{rpc_url}"
contract_address = "{registry_address:?}"
token_address = "{token:?}"
decimals = 6

[settlement.evm.key]
key_file = "{key_path}"
"#,
        state_dir = state_dir.path().display(),
        key_path = key_file.path().display(),
        rpc_url = anvil.rpc_url,
    )
    .expect("write config file");

    let command = connector_cli::run(&[
        "connector".to_string(),
        config_file.path().display().to_string(),
    ])
    .await
    .expect("run: a config-driven node");
    let connector_cli::Command::Serve(node) = command else {
        panic!("a config path must produce a servable node");
    };

    let body = serde_json::to_vec(&serde_json::json!({
        "id": "whoever-answers",
        "url": format!("http://{peer_addr}/ilp"),
    }))
    .unwrap();
    let response = node
        .router
        .oneshot(signed(&keypair, Method::POST, "/peers", body))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "the identity a URL serves is not checked against anything the operator supplied"
    );

    let established = body_json(response).await;
    assert_eq!(established["channel"]["status"], "created");
    let channel_id = established["channel"]["id"].as_str().expect("a channel id");

    // The channel really is with the address the document named.
    let reader = EvmSettlementBackend::connect(
        &anvil.rpc_url,
        DEPLOYER_PRIVATE_KEY,
        registry_address,
        token,
        6,
    )
    .await
    .expect("connect a reader");
    let other = reader
        .channel_counterparty(channel_id_bytes(channel_id))
        .await
        .expect("read the channel")
        .expect("it exists");
    assert_eq!(
        <[u8; 20]>::from(other),
        stranger,
        "the counterparty is whoever the URL said, and the operator's vetting of that URL is \
         the whole of the assurance"
    );

    // ...and it is that node's SETTLEMENT address, not the edge identity
    // the same document published beside it. The two are different keys
    // on different curves for different jobs, and this is where confusing
    // them would show: a channel derived from the edge key names a
    // participant `claimFromChannel` can never recover a signer to.
    let published_edge_key: [u8; 65] = hex_bytes(&("04".to_string() + &"cd".repeat(64)))
        .try_into()
        .expect("an uncompressed secp256k1 public key is 65 bytes");
    let edge_identity_as_an_address = derive_evm_address(&published_edge_key);
    assert_ne!(
        <[u8; 20]>::from(other),
        edge_identity_as_an_address,
        "the channel derives from the settlement address of the chain in question, never from \
         the edge identity a payload is sealed to"
    );
    assert_ne!(
        <[u8; 20]>::from(other),
        address_of(DEPLOYER_PRIVATE_KEY),
        "and never from this node's own address either"
    );
}

/// Issue #1220, limb 2's motivating case: an HTTP-only node --
/// `peer_expose = "http"`, `[node] http_endpoint` set and `btp_endpoint`
/// simply absent -- publishes a self-description a stranger can actually
/// dial, and a peering established against it lands over that one
/// carriage.
///
/// Node A here is a REAL config-driven node bound to a real socket, not
/// the hand-built fixture [`serve_self_description`] serves for the two
/// tests above: this is the exact shape issue #1220 reported broken (the
/// README's minimal config publishes no endpoint at all), so the
/// self-description under test is the one `connector_cli` itself produces
/// from a loaded `[node]` section, not one assembled by hand in this file.
#[tokio::test]
async fn an_http_only_nodes_self_description_is_dialable_and_a_counterparty_peers_with_it() {
    if !require_anvil() {
        return;
    }

    let anvil = Anvil::spawn(ANVIL_BASE_PORT + 20).await;
    let token =
        EvmSettlementBackend::deploy_mock_token(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
            .await
            .expect("deploy mock USDC");
    let deployed = EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
        .await
        .expect("deploy a TokenNetwork through a fresh registry");
    let registry_address = deployed.registry_address();
    drop(deployed);

    // ── Node A: HTTP-only, on a real socket, describing itself for real ──
    let mut node_a_key_file = tempfile::NamedTempFile::new().expect("temp key file");
    node_a_key_file
        .write_all(COUNTERPARTY_PRIVATE_KEY.as_bytes())
        .expect("write key file");
    let node_a_state_dir = tempfile::tempdir().expect("temp state dir");
    let node_a_listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let node_a_addr = node_a_listener.local_addr().expect("local addr");

    let mut node_a_config_file = tempfile::NamedTempFile::new().expect("temp config file");
    write!(
        node_a_config_file,
        r#"
client_edge_addr = "127.0.0.1:0"
state_dir = "{state_dir}"
peer_expose = "http"

[signer]
key_file = "{key_path}"

[node]
addresses     = ["g.example.nodea"]
http_endpoint = "http://{node_a_addr}/ilp"

[settlement.evm]
rpc_url = "{rpc_url}"
contract_address = "{registry_address:?}"
token_address = "{token:?}"
decimals = 6

[settlement.evm.key]
key_file = "{key_path}"
"#,
        state_dir = node_a_state_dir.path().display(),
        key_path = node_a_key_file.path().display(),
        rpc_url = anvil.rpc_url,
    )
    .expect("write config file");

    let command = connector_cli::run(&[
        "connector".to_string(),
        node_a_config_file.path().display().to_string(),
    ])
    .await
    .expect("run: an HTTP-only, config-driven node");
    let connector_cli::Command::Serve(node_a) = command else {
        panic!("a config path must produce a servable node");
    };

    let node_a_router = node_a.router.clone();
    tokio::spawn(async move {
        let _ = axum::Server::from_tcp(node_a_listener)
            .expect("serve node A's bound listener")
            .serve(node_a_router.into_make_service())
            .await;
    });

    // Node A's own self-description, read straight off its router: exactly
    // `httpEndpoint`, no `btpEndpoint` at all, and `peerCarriages` naming
    // only the one carriage `peer_expose = "http"` opened.
    let description_response = node_a
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/ilp")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(description_response.status(), StatusCode::OK);
    let document = body_json(description_response).await;
    assert_eq!(
        document["httpEndpoint"],
        serde_json::json!(format!("http://{node_a_addr}/ilp"))
    );
    assert!(
        document.get("btpEndpoint").is_none(),
        "an HTTP-only node must publish no btpEndpoint at all, not a null one: {document}"
    );
    assert_eq!(document["peerCarriages"], serde_json::json!(["http"]));

    // ── Node B: the counterparty, making the one authenticated write ─────
    let mut node_b_key_file = tempfile::NamedTempFile::new().expect("temp key file");
    node_b_key_file
        .write_all(DEPLOYER_PRIVATE_KEY.as_bytes())
        .expect("write key file");
    let node_b_state_dir = tempfile::tempdir().expect("temp state dir");
    let keypair = Keypair::generate(&mut OsRng);
    let write_key_hex = keypair
        .public
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();

    let mut node_b_config_file = tempfile::NamedTempFile::new().expect("temp config file");
    write!(
        node_b_config_file,
        r#"
client_edge_addr = "127.0.0.1:0"
state_dir = "{state_dir}"
peer_allow_plaintext_endpoints = true

[signer]
key_file = "{key_path}"

[operator]
bearer_token = "operator-secret"
write_keys = ["{write_key_hex}"]

[settlement.evm]
rpc_url = "{rpc_url}"
contract_address = "{registry_address:?}"
token_address = "{token:?}"
decimals = 6

[settlement.evm.key]
key_file = "{key_path}"
"#,
        state_dir = node_b_state_dir.path().display(),
        key_path = node_b_key_file.path().display(),
        rpc_url = anvil.rpc_url,
    )
    .expect("write config file");

    let command = connector_cli::run(&[
        "connector".to_string(),
        node_b_config_file.path().display().to_string(),
    ])
    .await
    .expect("run: the counterparty node");
    let connector_cli::Command::Serve(node_b) = command else {
        panic!("a config path must produce a servable node");
    };

    let peer_body = serde_json::to_vec(&serde_json::json!({
        "id": "node-a",
        "url": format!("http://{node_a_addr}/ilp"),
        "fee": 50,
        "max_packet_amount": 2_000,
    }))
    .unwrap();

    let response = node_b
        .router
        .oneshot(signed(&keypair, Method::POST, "/peers", peer_body))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "a counterparty's POST /peers against an HTTP-only node's real, \
         dialed self-description must succeed over HTTP"
    );
    let established = body_json(response).await;
    assert_eq!(established["id"], "node-a");
    assert_eq!(established["channel"]["status"], "created");
    assert_eq!(established["channel"]["chain"], "evm");
}
