//! A channel's id is derivable from its participants, and the chain is
//! what answers whether one exists (ADR 0059, issue #1158).
//!
//! Against a real, freshly-deployed `TokenNetwork` on a real (if
//! disposable) `anvil` -- the derivation is only worth anything if it
//! agrees with the Solidity byte for byte, and nothing but the Solidity
//! can say whether it does. `src/channel_id.rs`'s unit tests pin the
//! preimage layout; these pin that the layout is the contract's.

mod support;

use chrono::Duration;
use connector_settlement::{SettlementBackend, SettlementError};
use connector_settlement_evm::{derive_channel_id, EvmSettlementBackend};
use ethers::core::rand::thread_rng;
use ethers::providers::{Http, Provider};
use ethers::signers::{LocalWallet, Signer as EvmSigner};
use ethers::types::{Address, U256};

use support::{require_anvil, Anvil, DEPLOYER_PRIVATE_KEY};

/// `TokenNetwork.sol`'s own `MIN_SETTLEMENT_TIMEOUT` (one hour) plus a
/// second of margin -- the shortest challenge period a channel can be
/// opened with, and so how far the chain clock must move for
/// `settleChannel` to become due.
const SETTLEMENT_TIMEOUT_SECONDS: i64 = 3_601;

/// Advance `anvil`'s own chain clock and mine, so a settlement deadline
/// falls due without this test sleeping for an hour (the same device
/// `contract_suite.rs` uses).
async fn advance_anvil_time(rpc_url: &str, seconds: i64) {
    let provider = Provider::<Http>::try_from(rpc_url).expect("build provider");
    let _: serde_json::Value = provider
        .request("evm_increaseTime", [seconds])
        .await
        .expect("evm_increaseTime");
    let _: serde_json::Value = provider.request("evm_mine", ()).await.expect("evm_mine");
}

async fn backend(rpc_url: &str) -> EvmSettlementBackend {
    let token = EvmSettlementBackend::deploy_mock_token(rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
        .await
        .expect("deploy mock USDC");
    EvmSettlementBackend::deploy(rpc_url, DEPLOYER_PRIVATE_KEY, token)
        .await
        .expect("deploy a TokenNetwork through a fresh registry")
}

/// A counterparty this test never needs a key for: every transaction
/// below is signed by the backend's own address, and the counterparty is
/// only ever the other half of a pair.
fn some_counterparty() -> Address {
    LocalWallet::new(&mut thread_rng()).address()
}

/// The whole point: a node that knows only the counterparty's address can
/// compute where their channel is, ask the chain whether it is there, and
/// have `open` land on exactly that id.
#[tokio::test]
async fn a_pair_derives_the_channel_id_that_open_then_lands_on() {
    if !require_anvil() {
        return;
    }
    let anvil = Anvil::spawn().await;
    let backend = backend(&anvil.rpc_url).await;
    let counterparty = some_counterparty();

    assert_eq!(
        backend
            .channel_epoch(counterparty)
            .await
            .expect("read the pair's epoch"),
        U256::zero(),
        "a pair that has settled nothing is at epoch 0"
    );
    let derived = backend
        .derived_channel_id(counterparty)
        .await
        .expect("derive");
    assert_eq!(
        derived,
        derive_channel_id(backend.own_address(), counterparty, U256::zero()),
        "the backend's derivation is the free function's, with the epoch read from the chain"
    );

    // Absent, from the chain, before anything is opened.
    assert_eq!(
        backend.channel_with(counterparty).await.expect("read"),
        None,
        "a pair with no channel must be reported absent, not guessed at"
    );

    let opened = backend
        .open(counterparty.as_bytes().to_vec(), Duration::seconds(3_600))
        .await
        .expect("open");
    assert_eq!(
        opened, derived,
        "openChannel must land on the id the pair derived beforehand"
    );
    assert_eq!(
        backend.channel_with(counterparty).await.expect("read"),
        Some(opened),
        "and the chain must now report it found, at that same id"
    );
}

/// Order-independence, held against the contract rather than only against
/// the Rust: the id does not depend on which side is `own_address`.
#[tokio::test]
async fn either_side_of_a_pair_derives_the_same_id_as_the_chain_does() {
    if !require_anvil() {
        return;
    }
    let anvil = Anvil::spawn().await;
    let backend = backend(&anvil.rpc_url).await;
    let counterparty = some_counterparty();

    let opened = backend
        .open(counterparty.as_bytes().to_vec(), Duration::seconds(3_600))
        .await
        .expect("open");
    assert_eq!(
        derive_channel_id(counterparty, backend.own_address(), U256::zero()),
        opened,
        "the counterparty, deriving from its own side, must reach the same id"
    );
}

/// The epoch is what lets a pair start again: settlement advances it, the
/// pair derives a fresh id, and `open` succeeds at that one. Without it a
/// settled channel would hold the pair's only identifier forever.
#[tokio::test]
async fn a_settled_channel_frees_its_pair_to_open_again_at_the_next_epoch() {
    if !require_anvil() {
        return;
    }
    let anvil = Anvil::spawn().await;
    let backend = backend(&anvil.rpc_url).await;
    let counterparty = some_counterparty();

    let first = backend
        .open(
            counterparty.as_bytes().to_vec(),
            Duration::seconds(SETTLEMENT_TIMEOUT_SECONDS),
        )
        .await
        .expect("open");

    backend.close(&first).await.expect("close");
    assert_eq!(
        backend.channel_with(counterparty).await.expect("read"),
        Some(first.clone()),
        "a closed channel is still live: it holds the pair's id until it settles"
    );

    advance_anvil_time(&anvil.rpc_url, SETTLEMENT_TIMEOUT_SECONDS + 1).await;
    backend.settle(&first).await.expect("settle");

    assert_eq!(
        backend.channel_epoch(counterparty).await.expect("epoch"),
        U256::one(),
        "settlement advances the pair's epoch"
    );
    assert_eq!(
        backend.channel_with(counterparty).await.expect("read"),
        None,
        "and the pair is reported channel-less again"
    );

    let derived = backend
        .derived_channel_id(counterparty)
        .await
        .expect("derive");
    assert_ne!(
        derived, first,
        "the next channel must not reuse the settled id"
    );
    assert_eq!(
        derived,
        derive_channel_id(backend.own_address(), counterparty, U256::one()),
        "the next id is the pair's, at epoch 1"
    );

    let second = backend
        .open(counterparty.as_bytes().to_vec(), Duration::seconds(3_600))
        .await
        .expect("reopen after settlement");
    assert_eq!(
        second, derived,
        "the reopen lands on the derived epoch-1 id"
    );
    assert_eq!(
        backend.channel_with(counterparty).await.expect("read"),
        Some(second),
    );
}

/// One live channel per pair per token: the second open reverts on chain,
/// and this backend reports the revert rather than inventing an id.
#[tokio::test]
async fn a_second_open_on_a_live_pair_is_refused_by_the_chain() {
    if !require_anvil() {
        return;
    }
    let anvil = Anvil::spawn().await;
    let backend = backend(&anvil.rpc_url).await;
    let counterparty = some_counterparty();

    backend
        .open(counterparty.as_bytes().to_vec(), Duration::seconds(3_600))
        .await
        .expect("open");

    let err = backend
        .open(counterparty.as_bytes().to_vec(), Duration::seconds(3_600))
        .await
        .expect_err("a second channel for a live pair must be refused");
    assert!(
        matches!(err, SettlementError::Backend(_)),
        "the revert is reported as a backend error, got {err:?}"
    );
}

/// A different counterparty is a different pair, so it derives a
/// different id and is unaffected by the first pair's channel.
#[tokio::test]
async fn a_different_counterparty_is_a_different_pair_on_the_same_token_network() {
    if !require_anvil() {
        return;
    }
    let anvil = Anvil::spawn().await;
    let backend = backend(&anvil.rpc_url).await;
    let (first, second) = (some_counterparty(), some_counterparty());

    let opened = backend
        .open(first.as_bytes().to_vec(), Duration::seconds(3_600))
        .await
        .expect("open");

    assert_eq!(
        backend.channel_with(second).await.expect("read"),
        None,
        "a pair that never opened must still read absent"
    );
    let other = backend
        .open(second.as_bytes().to_vec(), Duration::seconds(3_600))
        .await
        .expect("open a channel with a second counterparty");
    assert_ne!(opened, other);
    assert_eq!(
        backend.channel_with(first).await.expect("read"),
        Some(opened),
        "the first pair's channel is where it was"
    );
}
