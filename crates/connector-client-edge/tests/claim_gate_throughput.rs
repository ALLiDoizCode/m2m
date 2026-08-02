//! Throughput and latency measurement for [`ClientClaimGate::ingest`]
//! (issue #686): how many fully verified, durably journaled claims per
//! second the gate admits, and what one claim's admission latency looks
//! like at huddle-shaped load. Written against the gate's public surface
//! only, so the same measurement runs unchanged before and after #686's
//! group-commit restructuring -- the numbers it prints are the before/after
//! evidence, not a pass/fail gate.
//!
//! `#[ignore]`d because it is a measurement, not a test: it runs for tens
//! of seconds, its numbers depend on the disk under `TMPDIR` (the fsync
//! floor is the whole subject), and it asserts nothing a CI box could
//! promise. Run it by hand:
//!
//! ```sh
//! cargo test -p connector-client-edge --test claim_gate_throughput \
//!     --release -- --ignored --nocapture
//! ```
//!
//! The workload mirrors `prototypes/tigerbeetle-claim-gate` in toon-meta
//! (branch `proto/tigerbeetle-claim-gate`): per session, strictly advancing
//! nonces on that session's own channel, each claim genuinely EIP-712
//! signed and verified -- nothing is stubbed out of the admission path, so
//! a printed claims/sec is what a fleet box's gate would actually sustain
//! on this disk.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use connector_client_edge::{ClientChannelRegistry, ClientClaimGate, DepositFloor, EvmChannel};
use connector_runtime::FileJournal;
use connector_signer::{derive_evm_address, evm_balance_proof_digest, to_hex, EvmBalanceProof};
use libsecp256k1::{Message, PublicKey, SecretKey};

const EVM_CHAIN_ID: u64 = 8453;
const TOKEN_NETWORK: [u8; 20] = [0x42; 20];
/// What each claim advances its channel by -- the huddle measurement's
/// per-frame price, so batches fill the way real load fills them.
const PRICE: u64 = 20;

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// One deterministic payer keypair, shared by every session: the gate
/// verifies per channel, not per key, and one key keeps setup cheap.
fn signer() -> (SecretKey, [u8; 20]) {
    let secret = SecretKey::parse(&[9u8; 32]).unwrap();
    let public = PublicKey::from_secret_key(&secret);
    (secret, derive_evm_address(&public.serialize()))
}

/// The 32-byte channel id session `index` claims on, as the hex string a
/// claim carries -- distinct per session so sessions contend only on the
/// gate's shared state, never on one watermark.
fn channel_id_hex(index: u32) -> String {
    let mut id = [0xabu8; 32];
    id[..4].copy_from_slice(&index.to_be_bytes());
    format!("0x{}", hex_encode(&id))
}

fn channel_id_bytes(index: u32) -> [u8; 32] {
    let mut id = [0xabu8; 32];
    id[..4].copy_from_slice(&index.to_be_bytes());
    id
}

/// A registry recording `sessions` channels, each with the shared test
/// keypair as its counterparty and a declared (`Unknown`) deposit floor,
/// so no chain is ever consulted -- the measurement is of the gate and its
/// journal, not of an RPC endpoint.
fn registry(sessions: u32) -> ClientChannelRegistry {
    let (_, address) = signer();
    let mut channels = ClientChannelRegistry::new();
    for index in 0..sessions {
        channels
            .record_evm(
                &channel_id_hex(index),
                EvmChannel {
                    counterparty: address,
                    chain_id: EVM_CHAIN_ID,
                    token_network_address: TOKEN_NETWORK,
                    deposit_floor: DepositFloor::Unknown,
                },
            )
            .expect("a 32-byte hex channel id");
    }
    channels
}

/// A claim JSON with a genuine EIP-712 signature over its own fields --
/// the same shape `@toon-protocol/client` sends, so the gate spends real
/// cryptographic work on every admission it counts.
fn signed_claim_json(secret: &SecretKey, session: u32, nonce: u64, amount: u64) -> String {
    let proof = EvmBalanceProof {
        channel_id: channel_id_bytes(session),
        nonce,
        transferred_amount: u128::from(amount),
        locked_amount: 0,
        locks_root: [0u8; 32],
        chain_id: EVM_CHAIN_ID,
        token_network_address: TOKEN_NETWORK,
    };
    let message = Message::parse(&evm_balance_proof_digest(&proof));
    let (signature, recovery_id) = libsecp256k1::sign(&message, secret);
    let mut signature_bytes = signature.serialize().to_vec();
    let recovery_byte: u8 = recovery_id.into();
    signature_bytes.push(recovery_byte + 27);
    let (_, address) = signer();
    format!(
        r#"{{
            "version": "1.0",
            "blockchain": "evm",
            "messageId": "msg-{nonce}",
            "timestamp": "2026-02-02T12:00:00.000Z",
            "senderId": "bench",
            "channelId": "{channel_id}",
            "nonce": {nonce},
            "transferredAmount": "{amount}",
            "lockedAmount": "0",
            "locksRoot": "0x{zeros}",
            "signature": "0x{signature}",
            "signerAddress": "{signer}",
            "chainId": {EVM_CHAIN_ID},
            "tokenNetworkAddress": "{token_network}"
        }}"#,
        channel_id = channel_id_hex(session),
        zeros = "0".repeat(64),
        signature = hex_encode(&signature_bytes),
        signer = to_hex(&address),
        token_network = to_hex(&TOKEN_NETWORK),
    )
}

/// Sustained throughput: `sessions` concurrent clients each submitting
/// strictly advancing claims as fast as the gate admits them, for
/// `seconds`. Prints aggregate accepted claims/sec.
async fn measure_throughput(gate: Arc<ClientClaimGate>, sessions: u32, seconds: u64) -> f64 {
    let stop = Arc::new(AtomicBool::new(false));
    let accepted = Arc::new(AtomicU64::new(0));
    let started = Instant::now();
    let mut tasks = Vec::new();
    for session in 0..sessions {
        let gate = gate.clone();
        let stop = stop.clone();
        let accepted = accepted.clone();
        tasks.push(tokio::spawn(async move {
            let (secret, _) = signer();
            let mut nonce = 0u64;
            while !stop.load(Ordering::Relaxed) {
                nonce += 1;
                let claim = signed_claim_json(&secret, session, nonce, nonce * PRICE);
                gate.ingest(&claim, PRICE)
                    .await
                    .expect("strictly advancing claims are always admissible");
                accepted.fetch_add(1, Ordering::Relaxed);
                // An admission that never awaited anything pending (the
                // pre-#686 gate blocks synchronously) would otherwise pin
                // its worker forever and starve the stop timer.
                tokio::task::yield_now().await;
            }
        }));
    }
    tokio::time::sleep(Duration::from_secs(seconds)).await;
    stop.store(true, Ordering::Relaxed);
    for task in tasks {
        task.await.expect("session task");
    }
    let elapsed = started.elapsed().as_secs_f64();
    accepted.load(Ordering::Relaxed) as f64 / elapsed
}

/// Paced latency: `sessions` clients each submitting `rate` claims/sec --
/// the huddle-audio shape -- for `seconds`, measuring each admission's
/// wall-clock time. Returns every latency in milliseconds, sorted.
async fn measure_latency(
    gate: Arc<ClientClaimGate>,
    sessions: u32,
    rate: u64,
    seconds: u64,
) -> Vec<f64> {
    let per_session = (rate * seconds) as usize;
    let interval = Duration::from_nanos(1_000_000_000 / rate);
    let mut tasks = Vec::new();
    for session in 0..sessions {
        let gate = gate.clone();
        tasks.push(tokio::spawn(async move {
            let (secret, _) = signer();
            let started = Instant::now();
            let mut latencies = Vec::with_capacity(per_session);
            for tick in 0..per_session {
                let target = interval * tick as u32;
                let elapsed = started.elapsed();
                if target > elapsed {
                    tokio::time::sleep(target - elapsed).await;
                }
                let nonce = tick as u64 + 1;
                let claim = signed_claim_json(&secret, session, nonce, nonce * PRICE);
                let submitted = Instant::now();
                gate.ingest(&claim, PRICE)
                    .await
                    .expect("strictly advancing claims are always admissible");
                latencies.push(submitted.elapsed().as_secs_f64() * 1000.0);
            }
            latencies
        }));
    }
    let mut all = Vec::new();
    for task in tasks {
        all.extend(task.await.expect("session task"));
    }
    all.sort_by(|a, b| a.partial_cmp(b).expect("finite latencies"));
    all
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() as f64 * p / 100.0) as usize).min(sorted.len() - 1)]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 16)]
#[ignore = "a measurement, not a test -- run by hand with --ignored --nocapture (see module doc)"]
async fn claim_admission_throughput_and_latency() {
    for sessions in [1u32, 16, 64] {
        let dir = tempfile::tempdir().expect("tempdir");
        let journal = FileJournal::open(dir.path().join("claims.log")).expect("journal");
        let gate = Arc::new(
            ClientClaimGate::restore(registry(sessions), Arc::new(journal))
                .expect("a fresh journal has nothing to replay"),
        );
        let claims_per_sec = measure_throughput(gate, sessions, 10).await;
        println!("throughput sessions={sessions} claims_per_sec={claims_per_sec:.0}");
    }

    let sessions = 10u32;
    let rate = 50u64;
    let dir = tempfile::tempdir().expect("tempdir");
    let journal = FileJournal::open(dir.path().join("claims.log")).expect("journal");
    let gate = Arc::new(
        ClientClaimGate::restore(registry(sessions), Arc::new(journal))
            .expect("a fresh journal has nothing to replay"),
    );
    let latencies = measure_latency(gate, sessions, rate, 10).await;
    println!(
        "latency sessions={sessions} rate={rate}/s p50_ms={:.1} p95_ms={:.1} p99_ms={:.1} max_ms={:.1}",
        percentile(&latencies, 50.0),
        percentile(&latencies, 95.0),
        percentile(&latencies, 99.0),
        latencies.last().copied().unwrap_or(f64::NAN),
    );
}
