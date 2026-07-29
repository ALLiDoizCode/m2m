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
//! And behind the route is the real published relay, the same image devnet
//! runs, so the whole shape is here: a PAID sealed publish goes in through the
//! connector and a FREE ordinary NIP-01 `REQ` takes the very same event back
//! out of the relay's public WebSocket, with nothing paid for the read.
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
    env("REHEARSAL_DESTINATION").unwrap_or_else(|| "g.local.relay".to_string())
}

/// The envelope target a real publisher sends. It matters more than it looks:
/// `HttpAppClient::deliver` resolves it against the route's `handler_url` with
/// `Url::join`, and RFC 3986 makes an absolute-path reference REPLACE the
/// base's path -- so `"/"` against `http://relay:3100/write` resolves to
/// `http://relay:3100/`, which the relay does not serve. `"/write"` is what
/// lands. `a_paid_write_whose_envelope_target_is_a_bare_slash_misses_the_relay`
/// proves the other side of that.
fn target() -> String {
    env("REHEARSAL_TARGET").unwrap_or_else(|| "/write".to_string())
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
    target: &str,
    body: &[u8],
    identity: &PublicKeyBytes,
) -> (Prepare, [u8; 32]) {
    let plaintext = EnvelopeRequest {
        method: "POST".to_string(),
        target: target.to_string(),
        headers: vec![("content-type".to_string(), "application/json".to_string())],
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

// ── A real Nostr event, and the free read that serves it back ────────────────

/// A genuinely signed NIP-01 event, and the `POST /write` body that carries it.
///
/// The relay runs with `TOON_DEV_MODE=false`, exactly as devnet does, so it
/// verifies this signature before storing anything -- which is what makes
/// "the relay stored it" a statement about a real event rather than about a
/// blob this probe made up. BIP-340 Schnorr over the event's own SHA-256 id;
/// neither `libsecp256k1` 0.6 nor `connector-signer` signs that way, hence
/// `k256`'s `schnorr` here and nowhere else in the workspace.
///
/// The publisher's key is a fixed local test value: this event is worth
/// nothing, is written only to a disposable container, and being deterministic
/// means a failed run can be re-read by pubkey.
fn signed_nostr_event(content: &str) -> (serde_json::Value, String) {
    use k256::schnorr::signature::hazmat::PrehashSigner;
    use k256::schnorr::SigningKey;
    use sha2::{Digest, Sha256};

    const PUBLISHER_KEY: [u8; 32] = [0x2a; 32];

    let signing_key = SigningKey::from_bytes(&PUBLISHER_KEY).expect("nostr signing key");
    let pubkey = hex_encode(&signing_key.verifying_key().to_bytes());
    let created_at = now_secs();

    // NIP-01's serialization for the id: the six-element array, no whitespace.
    let serialized = serde_json::json!([0, pubkey, created_at, 1, [], content]).to_string();
    let id = hex_encode(&Sha256::digest(serialized.as_bytes()));

    let signature: k256::schnorr::Signature = signing_key
        .sign_prehash(&hex_decode(&id))
        .expect("schnorr sign the event id");

    let event = serde_json::json!({
        "id": id,
        "pubkey": pubkey,
        "created_at": created_at,
        "kind": 1,
        "tags": [],
        "content": content,
        "sig": hex_encode(&signature.to_bytes()),
    });
    (event, id)
}

/// The relay's `POST /write` body: `{ "event": <event> }`.
fn write_body(event: &serde_json::Value) -> Vec<u8> {
    serde_json::json!({ "event": event })
        .to_string()
        .into_bytes()
}

/// The relay's free-read WebSocket, published to loopback by the compose file.
fn relay_ws() -> String {
    env("REHEARSAL_RELAY_WS").unwrap_or_else(|| "ws://127.0.0.1:7100".to_string())
}

/// Ask the relay's public WS for one event by id, with an ordinary NIP-01
/// `REQ` -- no payment, no claim, no connector: the free half of the loop,
/// spoken by anything that speaks Nostr. `None` means the relay answered
/// `EOSE` without ever sending the event, i.e. it does not have it.
async fn free_read_by_id(id: &str) -> Option<serde_json::Value> {
    use futures_util::{SinkExt, StreamExt};
    use tokio::time::{timeout, Duration};
    use tokio_tungstenite::tungstenite::Message;

    let (mut socket, _) = tokio_tungstenite::connect_async(relay_ws())
        .await
        .expect("connect the free-read WS");
    let request = serde_json::json!(["REQ", "rehearsal", { "ids": [id] }]).to_string();
    socket
        .send(Message::Text(request))
        .await
        .expect("send a NIP-01 REQ");

    while let Ok(Some(Ok(message))) = timeout(Duration::from_secs(10), socket.next()).await {
        let Message::Text(text) = message else {
            continue;
        };
        let frame: serde_json::Value = match serde_json::from_str(&text) {
            Ok(frame) => frame,
            Err(_) => continue,
        };
        match frame[0].as_str() {
            Some("EVENT") => {
                // Some deployed relays hand back the payload double-JSON-encoded
                // (a string where an object belongs); accept either shape rather
                // than reporting a real event as missing.
                return Some(match frame[2].as_str() {
                    Some(encoded) => serde_json::from_str(encoded).expect("event payload"),
                    None => frame[2].clone(),
                });
            }
            Some("EOSE") => return None,
            _ => continue,
        }
    }
    None
}

// ── 1. the relay's paid-write store is private ───────────────────────────────

/// The privacy invariant the compose file enforces by construction: `3100`
/// carries the PAID write surface and is never published, so the only way to
/// reach it is through the connector. If the host could POST to it directly,
/// every other check in this file would be theatre -- an unpaid writer would
/// simply skip the connector.
#[tokio::test]
async fn the_relays_paid_write_store_is_not_reachable_from_the_host() {
    let Some(_edge) = edge() else { return };
    let error = tokio::net::TcpStream::connect("127.0.0.1:3100")
        .await
        .err()
        .expect("127.0.0.1:3100 must not accept a connection from the host");
    println!("relay :3100 from the host: {error}");

    // ...while the FREE read surface on the same container is published.
    tokio::net::TcpStream::connect("127.0.0.1:7100")
        .await
        .expect("the free-read WS is published");
    println!("relay :7100 from the host: connected");
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

// ── 4. an unpaid publish is refused, and the relay stores nothing ────────────

#[tokio::test]
async fn an_unpaid_publish_is_answered_with_x402_terms_and_never_reaches_the_relay() {
    let Some(edge) = edge() else { return };
    let identity = fetch_identity(&edge).await;
    let (event, id) = signed_nostr_event("an unpaid write, which must never be stored");
    let (prepare, _secret) =
        sealed_prepare(&destination(), &target(), &write_body(&event), &identity);

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
    // reached and the relay was never asked to work for free.
    assert!(Prepare::decode(terms.to_string().as_bytes()).is_err());

    // The event is genuinely publishable -- same construction the paid check
    // uses, and the relay would have accepted it -- so its absence is the
    // refusal's doing, not a malformed event's.
    assert!(
        free_read_by_id(&id).await.is_none(),
        "the relay must not hold an event nobody paid for"
    );
    println!("REFUSED, AND NOT STORED -- free read of {id} came back EOSE with no EVENT");
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

    /// The whole loop in one run: a paid, sealed publish through the running
    /// connector's client edge lands a real Nostr event in the relay; the same
    /// event comes back over the relay's FREE WebSocket to a reader that pays
    /// nothing and never touches the connector; and the very claim that bought
    /// the write -- same channel, same nonce, same signature bytes -- redeems
    /// on chain through `EvmSettlementBackend::redeem`. The claim's value is
    /// backed by a deposit this test genuinely moved on chain, not a number it
    /// wrote down.
    #[tokio::test]
    async fn a_paid_publish_lands_in_the_relay_reads_back_free_and_redeems_on_chain() {
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
        let (event, id) = signed_nostr_event("a paid write, backed by a real channel");
        let (prepare, shared_secret) =
            sealed_prepare(&destination(), &target(), &write_body(&event), &identity);

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
        // The relay's own answer, sealed back through the connector: it names
        // the event id it stored, so the write landing is the relay's word.
        let stored: serde_json::Value =
            serde_json::from_slice(&envelope.body).expect("the relay's JSON answer");
        assert_eq!(stored["eventId"], id, "the relay stored THIS event");
        println!(
            "WRITE LANDED -- FULFILL status={} relay answer={}",
            envelope.status, stored
        );

        // ── the free read: the other half nobody had proven locally ─────────
        // No claim, no connector, no payment -- an ordinary NIP-01 REQ against
        // the published WS. Paid write in, free read out.
        let read_back = free_read_by_id(&id)
            .await
            .expect("the relay must serve the event it just stored");
        assert_eq!(read_back["id"], id);
        assert_eq!(read_back["sig"], event["sig"], "byte-identical signature");
        assert_eq!(read_back["content"], event["content"]);
        println!(
            "FREE READ -- ws REQ {{\"ids\":[\"{id}\"]}} returned kind {} by {}: {:?}",
            read_back["kind"], read_back["pubkey"], read_back["content"]
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

    /// The half of #492's app-delivery gap that `handler_url` alone cannot
    /// close. `HttpAppClient::deliver` resolves the envelope's target against
    /// `handler_url` with `Url::join`, and an absolute-path reference replaces
    /// the base's path (RFC 3986 §5.3), so a sender that says `"/"` reaches
    /// `http://relay:3100/` -- not `/write` -- no matter what the route
    /// configures. `infra/linode-node/connector-rust.toml` says the connector
    /// "takes no path from the packet"; this shows it does.
    ///
    /// Note what the miss is NOT: it is not an `F99`. Under ADR 0020 a 404 is
    /// a real answer that consumed real work, so it rides home on a FULFILL
    /// with `status: 404` and the payer is charged -- for nothing. The relay,
    /// of course, stores nothing.
    #[tokio::test]
    async fn a_paid_write_whose_envelope_target_is_a_bare_slash_misses_the_relay() {
        let (Some(edge), Some(rpc)) = (edge(), rpc()) else {
            return;
        };
        let backend = backend(&rpc).await;
        let (_channel, proof, signature) = funded_channel_and_claim(&backend).await;

        let identity = fetch_identity(&edge).await;
        let (event, id) = signed_nostr_event("a paid write aimed at the wrong path");
        let (prepare, shared_secret) =
            sealed_prepare(&destination(), "/", &write_body(&event), &identity);

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
        let bytes = response.bytes().await.expect("body");
        let fulfill = Fulfill::decode(&bytes).expect("ADR 0020: a 404 is an answer, not a reject");
        let opened = open_response(&shared_secret, &fulfill.data).expect("open sealed answer");
        let envelope = EnvelopeResponse::decode(&opened).expect("decode envelope");

        assert_eq!(envelope.status, 404, "the relay serves no `/`");
        assert!(free_read_by_id(&id).await.is_none(), "and stored nothing");
        println!(
            "TARGET \"/\" MISSED THE RELAY -- FULFILL status={} body={:?}; \
             the payer was charged and the relay stored nothing",
            envelope.status,
            String::from_utf8_lossy(&envelope.body)
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
