//! Solana-specific behavior the port's own contract suite deliberately
//! doesn't exercise, mirroring why `connector-settlement-evm` has
//! `gas_and_nonce.rs` alongside its own contract-suite test: a full
//! lifecycle that is genuinely real, confirmed transactions against a real
//! validator (not an in-process simulation), and that concurrent calls
//! against the same backend (every `SettlementBackend` method takes `&self`,
//! so nothing at the port level stops two calls racing) do not conflict.

mod support;

use std::sync::Arc;

use chrono::Duration;
use connector_settlement::{ChannelStatus, Claim, SettlementBackend};
use connector_settlement_solana::SolanaSettlementBackend;

use support::{require_solana_test_validator, SolanaValidator};

#[tokio::test]
async fn every_channel_operation_is_a_real_confirmed_transaction() {
    if !require_solana_test_validator() {
        return;
    }

    let validator = SolanaValidator::spawn().await;
    let backend = SolanaSettlementBackend::deploy(&validator.rpc_url)
        .await
        .expect("bind to the genesis-loaded settlement program");

    let channel = backend
        .open(b"real-validator-peer".to_vec(), Duration::seconds(3600))
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
    assert_eq!(state.status, ChannelStatus::Closed);
}

/// Two channels, funded concurrently through the *same*
/// `SolanaSettlementBackend` (shared behind one `Arc`, called via `&self`
/// from two tasks with no `.await` between them). Unlike
/// `EvmSettlementBackend`, this backend has no local nonce to race on --
/// each call independently fetches its own recent blockhash and submits an
/// independent, distinctly-keyed transaction -- so what this proves is that
/// nothing about sharing one fee-payer or one RPC connection across
/// concurrent submissions causes either to be silently dropped or to
/// clobber the other's state.
#[tokio::test]
async fn concurrent_calls_from_the_same_backend_do_not_conflict() {
    if !require_solana_test_validator() {
        return;
    }

    let validator = SolanaValidator::spawn().await;
    let backend = Arc::new(
        SolanaSettlementBackend::deploy(&validator.rpc_url)
            .await
            .expect("bind to the genesis-loaded settlement program"),
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

    // A third, immediately-following call proves the backend's state is
    // still consistent afterward too, not just that the two racing calls
    // each returned successfully.
    let state_a_again = backend.fund(&first, 50).await.expect("fund again");
    assert_eq!(state_a_again.deposited, 161);
}
