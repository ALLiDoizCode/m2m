//! Deployment rehearsal probe: drives a *running* local stack
//! (`deploy/connector-rust/local-stack/docker-compose.local.yml`) through the
//! client edge from outside, the way a real sender would, and then redeems the
//! very claim it paid with against the same local chain -- through
//! `EvmSettlementBackend`'s own production path, not a hand-rolled contract
//! call.
//!
//! That join is the point. `paid_write_end_to_end.rs` (issue #528) proves a
//! paid write against a real chain, but the connector it spawns has no
//! `[settlement]` section, so its accept/reject decision never consults an
//! on-chain deposit -- the chain is real but decorative for that path. The
//! stack this file drives *does* configure settlement, so "the write landed"
//! and "the money is redeemable on chain" are shown for one claim, in one run.
//!
//! LOCAL / DEV ONLY, and inert unless driven: every test below returns
//! immediately unless `REHEARSAL_EDGE` is set, exactly the way
//! `connector-settlement-evm`'s own `require_anvil()` gate keeps a
//! chain-needing test from failing a chainless CI run.
//!
//!   REHEARSAL_EDGE=http://127.0.0.1:3000 \
//!   REHEARSAL_RPC=http://127.0.0.1:8545 \
//!   REHEARSAL_REGISTRY=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 \
//!   REHEARSAL_TOKEN=0x5FbDB2315678afecb367f032d93F642f64180aa3 \
//!     cargo test -p connector --test local_stack_rehearsal -- --nocapture

use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{Duration as ChronoDuration, Utc};
use connector_domain::{
    derive_condition, EnvelopeRequest, EnvelopeResponse, Fulfill, Prepare, Reject,
};
use connector_signer::giftwrap::{derive_fulfillment, open_response, seal_request};
use connector_signer::{
    derive_evm_address, evm_balance_proof_digest, to_hex, EvmBalanceProof, LocalSigner,
    PublicKeyBytes, Signer,
};

const CLAIM_HEADER: &str = "ilp-payment-channel-claim";

/// anvil's own published default accounts (mnemonic "test test … junk").
/// Public knowledge, and only ever pointed at a disposable local chain.
/// Account 0 is the deployer that owns the local settlement topology and is
/// what `secrets/settlement.key` holds, so the backend this probe builds is
/// the same identity the running connector settles as. Account 3 is the payer.
const SETTLEMENT_KEY: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PAYER_KEY: &str = "7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// The client edge's base URL, or `None` -- in which case every test in this
/// file is a no-op, so a normal `cargo test` run never needs a live stack.
fn edge() -> Option<String> {
    env("REHEARSAL_EDGE")
}

fn destination() -> String {
    env("REHEARSAL_DESTINATION").unwrap_or_else(|| "g.local.app".to_string())
}

fn chain_id() -> u64 {
    env("REHEARSAL_CHAIN_ID")
        .unwrap_or_else(|| "31337".to_string())
        .parse()
        .expect("chain id")
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(s: &str) -> Vec<u8> {
    let s = s.trim_start_matches("0x");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

/// The connector's own identity, read from the running node the way a real
/// sender would learn it -- never reconstructed from a key file this test can
/// see, so what it seals to is genuinely what the deployed process holds.
async fn fetch_identity(edge: &str) -> PublicKeyBytes {
    let body: serde_json::Value = reqwest::get(format!("{edge}/ilp/identity"))
        .await
        .expect("GET /ilp/identity")
        .json()
        .await
        .expect("identity json");
    let bytes = hex_decode(body["publicKey"].as_str().expect("publicKey"));
    bytes.as_slice().try_into().expect("65-byte public key")
}

/// A `Prepare` a real sender would form: an OER `EnvelopeRequest` gift-wrapped
/// to the terminating connector's identity (ADR 0018), under a condition minted
/// from the fulfilment that same wrap's shared secret derives (ADR 0019, issue
/// #525). The app supplies nothing toward it -- `stub-app` holds no secret and
/// performs no cryptography, so only a sender who genuinely sealed to *this*
/// connector's identity can have minted a condition it will ever match.
fn sealed_prepare(
    destination: &str,
    body: &[u8],
    identity: &PublicKeyBytes,
) -> (Prepare, [u8; 32]) {
    let plaintext = EnvelopeRequest {
        method: "POST".to_string(),
        target: "/".to_string(),
        headers: vec![],
        body: body.to_vec(),
    }
    .encode();
    let (data, shared_secret) = seal_request(&plaintext, identity).expect("seal");
    (
        Prepare {
            amount: 0,
            expires_at: Utc::now() + ChronoDuration::minutes(5),
            execution_condition: derive_condition(&derive_fulfillment(&shared_secret)),
            destination: destination.to_string(),
            data,
        },
        shared_secret,
    )
}

/// Seconds since the epoch -- used as a nonce so repeated runs against one
/// long-lived connector process keep advancing its in-memory claim watermark
/// instead of replaying against it.
fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs()
}

/// The signer behind `secret_hex`.
fn signer_for(secret_hex: &str) -> LocalSigner {
    let secret: [u8; 32] = hex_decode(secret_hex).try_into().expect("32-byte key");
    LocalSigner::from_secret_bytes("rehearsal", secret).expect("signer")
}

fn address_of(secret_hex: &str) -> [u8; 20] {
    derive_evm_address(&signer_for(secret_hex).public_key().expect("public key"))
}

/// Sign an EIP-712 `BalanceProof` digest through this workspace's *production*
/// signing path -- `Signer::sign` + `Signature::to_bytes`, whose byte 64 is
/// libsecp256k1's raw recovery id in `{0, 1}`. Deliberately no `+27` anywhere
/// in this file: issue #590/#591 moved that normalisation to the settlement
/// boundary, and a probe that pre-shifted the byte itself would prove nothing
/// about whether the boundary does its job.
fn production_signature(secret_hex: &str, proof: &EvmBalanceProof) -> [u8; 65] {
    signer_for(secret_hex)
        .sign(&evm_balance_proof_digest(proof))
        .expect("sign")
        .to_bytes()
}

/// The client-edge claim JSON for `proof`, signed by `secret_hex`.
fn claim_json(proof: &EvmBalanceProof, secret_hex: &str, signature: &[u8]) -> String {
    format!(
        r#"{{
            "version": "1.0",
            "blockchain": "evm",
            "messageId": "rehearsal-{nonce}",
            "timestamp": "2026-07-28T00:00:00.000Z",
            "senderId": "rehearsal-client",
            "channelId": "0x{channel_id}",
            "nonce": {nonce},
            "transferredAmount": "{amount}",
            "lockedAmount": "0",
            "locksRoot": "0x{zeros}",
            "signature": "0x{signature}",
            "signerAddress": "{address}",
            "chainId": {chain_id},
            "tokenNetworkAddress": "{token_network}"
        }}"#,
        nonce = proof.nonce,
        channel_id = hex_encode(&proof.channel_id),
        amount = proof.transferred_amount,
        zeros = "0".repeat(64),
        signature = hex_encode(signature),
        address = to_hex(&address_of(secret_hex)),
        chain_id = proof.chain_id,
        token_network = to_hex(&proof.token_network_address),
    )
}

// ── 2. identity ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_client_edge_answers_a_65_byte_uncompressed_secp256k1_identity() {
    let Some(edge) = edge() else { return };
    let identity = fetch_identity(&edge).await;
    assert_eq!(identity.len(), 65);
    assert_eq!(identity[0], 0x04, "uncompressed secp256k1 key");
    println!("identity: 0x{}", hex_encode(&identity));
}

// ── 3. price ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_client_edge_quotes_the_configured_price_of_the_terminated_route() {
    let Some(edge) = edge() else { return };
    let destination = destination();
    let body: serde_json::Value =
        reqwest::get(format!("{edge}/ilp/routes/price?destination={destination}"))
            .await
            .expect("GET /ilp/routes/price")
            .json()
            .await
            .expect("price json");
    println!("price: {body}");
    assert_eq!(body["destination"], destination);
    assert!(body["price"].as_u64().expect("price") > 0);
}

// ── 4. an unpaid packet is answered with terms, not service ──────────────────

#[tokio::test]
async fn an_unpaid_packet_to_a_priced_route_is_answered_with_x402_terms() {
    let Some(edge) = edge() else { return };
    let identity = fetch_identity(&edge).await;
    let (prepare, _secret) = sealed_prepare(&destination(), b"unpaid probe", &identity);

    let response = reqwest::Client::new()
        .post(format!("{edge}/ilp"))
        .body(prepare.encode())
        .send()
        .await
        .expect("POST /ilp");

    assert_eq!(response.status().as_u16(), 402, "issue #526's guarantee");
    assert!(response.headers().contains_key("payment-required"));
    let terms: serde_json::Value = response.json().await.expect("x402 terms");
    println!("x402 terms: {terms}");
    assert_eq!(terms["x402Version"], 2);
    assert_eq!(terms["accepts"][0]["scheme"], "toon-channel");
    // No OER packet came back at all, so `Connector::handle_prepare` was never
    // reached and the app was never asked to work for free.
    assert!(Prepare::decode(terms.to_string().as_bytes()).is_err());
}

// ── 5 + 6. a paid write, and that same claim redeeming on chain ──────────────

mod on_chain {
    use super::*;
    use connector_settlement::{Claim, SettlementBackend, SettlementError};
    use connector_settlement_evm::EvmSettlementBackend;
    use ethers::contract::abigen;
    use ethers::providers::{Http, Middleware, Provider};
    use ethers::types::{Address as EvmAddress, BlockNumber, U256};
    use std::sync::Arc;

    abigen!(
        Erc20,
        r#"[
            function balanceOf(address account) external view returns (uint256)
        ]"#
    );

    const DEPOSIT: u128 = 5_000;
    const TRANSFERRED: u128 = 1_000;

    fn rpc() -> Option<String> {
        env("REHEARSAL_RPC")
    }

    fn registry() -> EvmAddress {
        env("REHEARSAL_REGISTRY")
            .expect("REHEARSAL_REGISTRY")
            .parse()
            .expect("registry address")
    }

    fn token() -> EvmAddress {
        env("REHEARSAL_TOKEN")
            .expect("REHEARSAL_TOKEN")
            .parse()
            .expect("token address")
    }

    fn parse_channel_id(id: &str) -> [u8; 32] {
        hex_decode(id).try_into().expect("32-byte channel id")
    }

    /// A real `EvmSettlementBackend`, connected exactly the way the running
    /// container's own is -- through the registry, with the same key.
    async fn backend(rpc: &str) -> EvmSettlementBackend {
        EvmSettlementBackend::connect(rpc, SETTLEMENT_KEY, registry(), token())
            .await
            .expect("connect through the TokenNetworkRegistry")
    }

    /// The address every redeemed claim pays out to -- `claimFromChannel`
    /// transfers to `msg.sender`, which is the backend's own wallet.
    fn redeemer() -> EvmAddress {
        EvmAddress::from(address_of(SETTLEMENT_KEY))
    }

    /// A freshly opened channel, funded with real on-chain value, and a claim
    /// against it signed by the payer through the production signing path.
    async fn funded_channel_and_claim(
        backend: &EvmSettlementBackend,
    ) -> (connector_settlement::ChannelId, EvmBalanceProof, [u8; 65]) {
        let channel = backend
            .open(address_of(PAYER_KEY).to_vec(), ChronoDuration::hours(1))
            .await
            .expect("open a real channel");
        let funded = backend
            .fund(&channel, DEPOSIT)
            .await
            .expect("fund with real ERC-20 value");
        assert_eq!(funded.deposited, DEPOSIT, "a real transaction moved this");

        let proof = EvmBalanceProof {
            channel_id: parse_channel_id(&channel.0),
            nonce: now_secs(),
            transferred_amount: TRANSFERRED,
            locked_amount: 0,
            locks_root: [0u8; 32],
            chain_id: chain_id(),
            token_network_address: backend.address().0,
        };
        let signature = production_signature(PAYER_KEY, &proof);
        (channel, proof, signature)
    }

    /// Checks 5 and 6 joined: a paid write through the running connector's
    /// client edge, and then that same claim -- same channel, same nonce, same
    /// signature bytes -- redeemed on chain through
    /// `EvmSettlementBackend::redeem`. The claim's value is backed by a deposit
    /// this test genuinely moved on chain, not a number it wrote down.
    #[tokio::test]
    async fn a_paid_write_and_its_claim_redeem_on_chain_in_one_run() {
        let (Some(edge), Some(rpc)) = (edge(), rpc()) else {
            return;
        };
        let backend = backend(&rpc).await;
        let provider = Provider::<Http>::try_from(rpc.as_str()).expect("provider");
        let usdc = Erc20::new(token(), Arc::new(provider.clone()));

        let (channel, proof, signature) = funded_channel_and_claim(&backend).await;
        println!("channel {channel} funded on chain: deposited={DEPOSIT}");
        assert!(
            signature[64] < 2,
            "the wire carries libsecp256k1's raw {{0,1}} recovery id (issue #591)"
        );
        println!("claim signature recovery id on the wire: {}", signature[64]);

        // ── the paid write ──────────────────────────────────────────────────
        let identity = fetch_identity(&edge).await;
        let body = b"a paid write, backed by a real channel";
        let (prepare, shared_secret) = sealed_prepare(&destination(), body, &identity);

        let response = reqwest::Client::new()
            .post(format!("{edge}/ilp"))
            .header(
                CLAIM_HEADER,
                BASE64.encode(claim_json(&proof, PAYER_KEY, &signature).as_bytes()),
            )
            .body(prepare.encode())
            .send()
            .await
            .expect("POST /ilp");
        assert_eq!(response.status().as_u16(), 200);
        let bytes = response.bytes().await.expect("body");

        let fulfill = match Fulfill::decode(&bytes) {
            Ok(fulfill) => fulfill,
            Err(_) => {
                let reject = Reject::decode(&bytes).expect("neither FULFILL nor REJECT");
                panic!("expected a FULFILL, got REJECT: {}", reject.message);
            }
        };
        // The connector derived this itself from the wrap's shared secret
        // (ADR 0019) -- the app never saw it and could not have supplied it.
        assert_eq!(fulfill.fulfillment, derive_fulfillment(&shared_secret));
        let opened = open_response(&shared_secret, &fulfill.data).expect("open sealed answer");
        let envelope = EnvelopeResponse::decode(&opened).expect("decode envelope");
        assert_eq!(envelope.status, 200);
        assert!(envelope.body.ends_with(body));
        println!(
            "WRITE LANDED -- FULFILL status={} body={:?}",
            envelope.status,
            String::from_utf8_lossy(&envelope.body)
        );

        // ── the same claim, redeemed on chain ───────────────────────────────
        let before: U256 = usdc.balance_of(redeemer()).call().await.expect("balance");
        let state = backend
            .redeem(
                &channel,
                Claim {
                    nonce: proof.nonce,
                    cumulative_amount: TRANSFERRED,
                    signature: signature.to_vec(),
                },
            )
            .await
            .expect("redeem must succeed now that #591 normalizes the recovery id");
        let after: U256 = usdc.balance_of(redeemer()).call().await.expect("balance");

        assert_eq!(state.redeemed, TRANSFERRED);
        assert_eq!(after - before, U256::from(TRANSFERRED), "real value moved");

        let block = provider
            .get_block_with_txs(BlockNumber::Latest)
            .await
            .expect("latest block")
            .expect("block");
        println!(
            "CLAIM REDEEMED -- block {} tx {:?}; redeemer USDC {before} -> {after} (+{TRANSFERRED})",
            block.number.expect("number"),
            block.transactions.last().map(|tx| tx.hash),
        );
    }

    /// The refusal branch #591 introduced: a trailing byte outside both
    /// `{0,1}` and `{27,28}` is rejected at the settlement boundary and never
    /// submitted, so it costs no gas rather than mining a reverted
    /// transaction. Proven by the redeemer's own on-chain transaction count
    /// not moving across the call.
    #[tokio::test]
    async fn a_claim_signature_with_an_out_of_range_recovery_id_is_refused_before_submission() {
        let Some(rpc) = rpc() else { return };
        let backend = backend(&rpc).await;
        let provider = Provider::<Http>::try_from(rpc.as_str()).expect("provider");

        let (channel, proof, signature) = funded_channel_and_claim(&backend).await;
        let mut signature = signature.to_vec();
        // Neither libsecp256k1's {0,1} nor Ethereum's {27,28}.
        signature[64] = 7;

        let nonce_before = provider
            .get_transaction_count(redeemer(), None)
            .await
            .expect("tx count");
        let error = backend
            .redeem(
                &channel,
                Claim {
                    nonce: proof.nonce,
                    cumulative_amount: TRANSFERRED,
                    signature,
                },
            )
            .await
            .expect_err("an out-of-range recovery id must be refused");
        let nonce_after = provider
            .get_transaction_count(redeemer(), None)
            .await
            .expect("tx count");

        assert!(
            matches!(error, SettlementError::InvalidClaimSignature(_)),
            "expected InvalidClaimSignature, got {error:?}"
        );
        assert_eq!(
            nonce_before, nonce_after,
            "refused before submission -- no transaction, no gas"
        );
        println!("REFUSED before submission: {error}");
        println!("redeemer tx count unchanged at {nonce_before} -- no gas burned");
    }
}
