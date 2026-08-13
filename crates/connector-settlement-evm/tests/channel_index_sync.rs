//! `EvmChannelIndexSyncer` against a real, disposable `anvil` chain (ADR
//! 0007, issue #661): a channel opened and funded on chain shows up in the
//! index once it is deep enough behind head, a channel inside the
//! confirmation window does not, and a settled channel is reported
//! [`ChannelIndexLookup::Terminal`]. See `tests/support/mod.rs` for how the
//! chain is stood up.

mod support;

use chrono::Duration;
use connector_settlement::SettlementBackend;
use connector_settlement_evm::EvmSettlementBackend;
use connector_settlement_evm::{ChannelIndexLookup, EvmChannelIndex, EvmChannelIndexSyncer};
use ethers::core::rand::thread_rng;
use ethers::providers::{Http, Provider};
use ethers::signers::{LocalWallet, Signer as EvmSigner};

use support::{require_anvil, Anvil, DEPLOYER_PRIVATE_KEY};

/// `MIN_SETTLEMENT_TIMEOUT` plus margin -- see `contract_suite.rs`'s own
/// constant of the same shape.
const INSTANT_SETTLEMENT_TIMEOUT_SECONDS: i64 = 3_601;

async fn advance_anvil_time(rpc_url: &str, seconds: i64) {
    let provider = Provider::<Http>::try_from(rpc_url).expect("build provider");
    let _: serde_json::Value = provider
        .request("evm_increaseTime", [seconds])
        .await
        .expect("evm_increaseTime");
    let _: serde_json::Value = provider.request("evm_mine", ()).await.expect("evm_mine");
}

/// Mine `count` empty blocks -- how this test pushes a channel-open past a
/// configured confirmation depth without waiting on real wall-clock time.
async fn mine_blocks(rpc_url: &str, count: u64) {
    let provider = Provider::<Http>::try_from(rpc_url).expect("build provider");
    for _ in 0..count {
        let _: serde_json::Value = provider.request("evm_mine", ()).await.expect("evm_mine");
    }
}

/// Run `syncer.sync_once` until it reports no more progress -- the same
/// "drain the backlog" loop `EvmChannelIndexSyncer::run` performs, without
/// its indefinite poll sleep, so a test can assert on a caught-up index.
async fn sync_to_caught_up(syncer: &EvmChannelIndexSyncer, index: &EvmChannelIndex) {
    for _ in 0..10_000 {
        let progressed = syncer.sync_once(index).await.expect("sync_once");
        if progressed == 0 {
            return;
        }
    }
    panic!("channel index sync did not converge after 10,000 bounded ranges");
}

#[tokio::test]
async fn a_channel_opened_and_funded_on_chain_is_indexed_once_confirmed() {
    if !require_anvil() {
        return;
    }
    let anvil = Anvil::spawn().await;
    let rpc_url = anvil.rpc_url.clone();

    let token = EvmSettlementBackend::deploy_mock_token(&rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
        .await
        .expect("deploy mock USDC");
    let backend = EvmSettlementBackend::deploy(&rpc_url, DEPLOYER_PRIVATE_KEY, token)
        .await
        .expect("deploy a TokenNetwork through a fresh registry");

    let counterparty = LocalWallet::new(&mut thread_rng())
        .address()
        .as_bytes()
        .to_vec();
    let channel = backend
        .open(
            counterparty.clone(),
            Duration::seconds(INSTANT_SETTLEMENT_TIMEOUT_SECONDS),
        )
        .await
        .expect("open a channel");
    backend.fund(&channel, 750).await.expect("fund the channel");

    // One confirmation, and mine a couple more blocks so the open/fund logs
    // are comfortably behind head.
    mine_blocks(&rpc_url, 3).await;

    let index = EvmChannelIndex::open(None).expect("open in-memory index");
    let syncer =
        EvmChannelIndexSyncer::new(&rpc_url, backend.address(), 1, 0).expect("build syncer");
    sync_to_caught_up(&syncer, &index).await;

    let channel_id = support::channel_id_bytes(&channel.0);
    match index.lookup(&channel_id, backend.own_address()) {
        ChannelIndexLookup::Active {
            counterparty: found,
            deposit,
        } => {
            assert_eq!(found.as_bytes(), counterparty.as_slice());
            assert_eq!(deposit, ethers::types::U256::from(750u64));
        }
        other => panic!("expected an active, funded channel, got {other:?}"),
    }
}

#[tokio::test]
async fn a_channel_inside_the_confirmation_window_is_not_yet_indexed() {
    if !require_anvil() {
        return;
    }
    let anvil = Anvil::spawn().await;
    let rpc_url = anvil.rpc_url.clone();

    let token = EvmSettlementBackend::deploy_mock_token(&rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
        .await
        .expect("deploy mock USDC");
    let backend = EvmSettlementBackend::deploy(&rpc_url, DEPLOYER_PRIVATE_KEY, token)
        .await
        .expect("deploy a TokenNetwork through a fresh registry");

    let counterparty = LocalWallet::new(&mut thread_rng())
        .address()
        .as_bytes()
        .to_vec();
    let channel = backend
        .open(
            counterparty,
            Duration::seconds(INSTANT_SETTLEMENT_TIMEOUT_SECONDS),
        )
        .await
        .expect("open a channel");

    // A confirmation depth deeper than this chain has ever reached: the
    // open is real, but this index must not have caught up to it yet.
    let index = EvmChannelIndex::open(None).expect("open in-memory index");
    let syncer =
        EvmChannelIndexSyncer::new(&rpc_url, backend.address(), 1_000, 0).expect("build syncer");
    sync_to_caught_up(&syncer, &index).await;

    let channel_id = support::channel_id_bytes(&channel.0);
    assert_eq!(
        index.lookup(&channel_id, backend.own_address()),
        ChannelIndexLookup::Miss,
        "a channel inside the confirmation window must fall through to a direct chain read, \
         not be answered from an index that has not caught up to it"
    );
}

#[tokio::test]
async fn a_settled_channel_is_indexed_as_terminal_without_a_further_chain_read() {
    if !require_anvil() {
        return;
    }
    let anvil = Anvil::spawn().await;
    let rpc_url = anvil.rpc_url.clone();

    let token = EvmSettlementBackend::deploy_mock_token(&rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
        .await
        .expect("deploy mock USDC");
    let backend = EvmSettlementBackend::deploy(&rpc_url, DEPLOYER_PRIVATE_KEY, token)
        .await
        .expect("deploy a TokenNetwork through a fresh registry");

    let counterparty = LocalWallet::new(&mut thread_rng())
        .address()
        .as_bytes()
        .to_vec();
    let channel = backend
        .open(
            counterparty,
            Duration::seconds(INSTANT_SETTLEMENT_TIMEOUT_SECONDS),
        )
        .await
        .expect("open a channel");
    backend.close(&channel).await.expect("close the channel");
    advance_anvil_time(&rpc_url, INSTANT_SETTLEMENT_TIMEOUT_SECONDS).await;
    backend.settle(&channel).await.expect("settle the channel");
    mine_blocks(&rpc_url, 3).await;

    let index = EvmChannelIndex::open(None).expect("open in-memory index");
    let syncer =
        EvmChannelIndexSyncer::new(&rpc_url, backend.address(), 1, 0).expect("build syncer");
    sync_to_caught_up(&syncer, &index).await;

    let channel_id = support::channel_id_bytes(&channel.0);
    assert_eq!(
        index.lookup(&channel_id, backend.own_address()),
        ChannelIndexLookup::Terminal
    );
}
