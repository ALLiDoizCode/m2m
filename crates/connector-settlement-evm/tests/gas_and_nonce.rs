//! Chain-specific behavior the port's own contract suite deliberately
//! doesn't exercise, since it is specific to *how* a real backend talks to
//! a chain rather than to the port's channel-lifecycle rules: real gas
//! estimation, and nonce safety under concurrent calls against the same
//! backend (every `SettlementBackend` method takes `&self`, so nothing at
//! the port level stops two calls racing).

mod support;

use std::sync::Arc;

use chrono::Duration;
use connector_settlement::{Claim, SettlementBackend};
use connector_settlement_evm::EvmSettlementBackend;

use support::{require_anvil, Anvil, DEPLOYER_PRIVATE_KEY};

/// `open`, `fund`, `redeem` and `close` are all real transactions against
/// a real chain with no manually-specified gas limit anywhere in
/// `EvmSettlementBackend` -- every one of them only succeeds if ethers'
/// automatic `eth_estimateGas` round trip against the deployed contract
/// produced a workable limit. A wrong or missing estimate would surface
/// here as an "out of gas" revert or a `SettlementError::Backend` from a
/// failed `eth_estimateGas` call, not a hang.
#[tokio::test]
async fn every_channel_operation_estimates_its_own_gas_and_succeeds() {
    if !require_anvil() {
        return;
    }

    let anvil = Anvil::spawn().await;
    let backend = EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY)
        .await
        .expect("deploy SettlementChannel");

    let channel = backend
        .open(b"gas-estimation-peer".to_vec(), Duration::seconds(3600))
        .await
        .expect("open");
    let state = backend.fund(&channel, 1_000).await.expect("fund");
    assert_eq!(state.deposited, 1_000);

    let state = backend
        .redeem(
            &channel,
            Claim {
                cumulative_amount: 400,
                signature: vec![9],
            },
        )
        .await
        .expect("redeem");
    assert_eq!(state.redeemed, 400);

    let state = backend.close(&channel).await.expect("close");
    assert_eq!(state.status, connector_settlement::ChannelStatus::Closed);
}

/// Two channels, funded concurrently from the *same* signer through the
/// *same* `EvmSettlementBackend` (shared behind one `Arc`, called via
/// `&self` from two tasks with no `.await` between them) -- a real race
/// for "what is my next nonce", which a naive client (each call
/// independently asking the node for its pending nonce) can lose: both
/// reads can observe the same pending count before either transaction is
/// broadcast, so both would submit the same nonce and one would be
/// rejected or silently replace the other. This only both land, each with
/// their own funded amount, because `EvmSettlementBackend` wraps its
/// signer in ethers' `NonceManagerMiddleware`, which allocates nonces
/// locally rather than re-deriving each one from a racy on-chain read.
#[tokio::test]
async fn concurrent_calls_from_the_same_signer_do_not_conflict_on_nonce() {
    if !require_anvil() {
        return;
    }

    let anvil = Anvil::spawn().await;
    let backend = Arc::new(
        EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY)
            .await
            .expect("deploy SettlementChannel"),
    );

    let first = backend
        .open(b"peer-one".to_vec(), Duration::seconds(3600))
        .await
        .expect("open first channel");
    let second = backend
        .open(b"peer-two".to_vec(), Duration::seconds(3600))
        .await
        .expect("open second channel");

    let backend_a = Arc::clone(&backend);
    let first_a = first.clone();
    let backend_b = Arc::clone(&backend);
    let second_b = second.clone();

    let (result_a, result_b) = tokio::join!(
        async move { backend_a.fund(&first_a, 111).await },
        async move { backend_b.fund(&second_b, 222).await },
    );

    let state_a = result_a.expect("concurrent fund of the first channel");
    let state_b = result_b.expect("concurrent fund of the second channel");
    assert_eq!(state_a.deposited, 111);
    assert_eq!(state_b.deposited, 222);

    // A third, immediately-following call proves the nonce sequence is
    // still consistent afterward too -- a manager that had desynced from
    // the two concurrent sends above would misfire here, not just during
    // the race itself.
    let state_a_again = backend.fund(&first, 50).await.expect("fund again");
    assert_eq!(state_a_again.deposited, 161);
}
