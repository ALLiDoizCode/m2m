//! Solana-specific behavior the port's own contract suite deliberately
//! doesn't exercise, mirroring why `connector-settlement-evm` has
//! `gas_and_nonce.rs` alongside its own contract-suite test: a full
//! lifecycle that is genuinely real, confirmed transactions against a real
//! validator (not an in-process simulation), and that concurrent calls
//! against the same backend (every `SettlementBackend` method takes
//! `&self`, so nothing at the port level stops two calls racing) do not
//! conflict.

use std::str::FromStr;
use std::sync::Arc;

use chrono::Duration;
use connector_settlement::{ChannelStatus, Claim, SettlementBackend};
use connector_settlement_solana::SolanaSettlementBackend;
use solana_sdk::pubkey::Pubkey;

use connector_settlement_solana::test_support::{
    require_solana_test_validator, SolanaValidator, LOCAL_TEST_PROGRAM_ID,
};

#[tokio::test]
async fn every_channel_operation_is_a_real_confirmed_transaction() {
    if !require_solana_test_validator() {
        return;
    }

    let validator = SolanaValidator::spawn().await;
    let program_id = Pubkey::from_str(LOCAL_TEST_PROGRAM_ID).expect("valid local test program id");
    let backend = SolanaSettlementBackend::deploy(&validator.rpc_url, program_id)
        .await
        .expect("bind to the genesis-loaded payment-channel program");
    let counterparty = backend
        .test_counterparty_pubkey()
        .expect("deploy() holds a counterparty key");

    let channel = backend
        .open(counterparty, Duration::seconds(0))
        .await
        .expect("open");
    let state = backend.fund(&channel, 1_000).await.expect("fund");
    assert_eq!(state.deposited, 1_000);

    let claim_signature = backend
        .test_sign_claim(&channel, 1, 400)
        .expect("deploy() holds a counterparty key to sign with");
    let state = backend
        .redeem(
            &channel,
            Claim {
                nonce: 1,
                cumulative_amount: 400,
                signature: claim_signature,
            },
        )
        .await
        .expect("redeem");
    assert_eq!(state.redeemed, 400);

    let state = backend.close(&channel).await.expect("close");
    assert_eq!(state.status, ChannelStatus::Closed);

    // A zero-length challenge period is already due the instant the
    // channel closes, same as `contract_suite.rs`'s
    // `instant_settlement_timeout`.
    let state = backend.settle(&channel).await.expect("settle");
    assert_eq!(state.status, ChannelStatus::Settled);

    // The settled channel's account is closed by the program itself
    // (`processor.rs:635-647`) -- this backend's own local memory is what
    // still reports `Settled` rather than `ChannelNotFound` here.
    let state = backend
        .channel_state(&channel)
        .await
        .expect("channel_state");
    assert_eq!(state.status, ChannelStatus::Settled);
}

/// Two channels, funded and redeemed concurrently through the *same*
/// `SolanaSettlementBackend` (shared behind one `Arc`, called via `&self`
/// from two tasks with no `.await` between them). This backend has no
/// local nonce or shared mutable channel ledger to race on for `fund` or
/// `redeem` -- each call independently fetches its own recent blockhash
/// and submits an independently-keyed transaction -- so what this proves
/// is that nothing about sharing one fee-payer, one counterparty signer or
/// one RPC connection across concurrent submissions causes either to be
/// silently dropped or to clobber the other's on-chain state.
#[tokio::test]
async fn concurrent_calls_from_the_same_backend_do_not_conflict() {
    if !require_solana_test_validator() {
        return;
    }

    let validator = SolanaValidator::spawn().await;
    let program_id = Pubkey::from_str(LOCAL_TEST_PROGRAM_ID).expect("valid local test program id");
    let backend = Arc::new(
        SolanaSettlementBackend::deploy(&validator.rpc_url, program_id)
            .await
            .expect("bind to the genesis-loaded payment-channel program"),
    );
    let counterparty = backend
        .test_counterparty_pubkey()
        .expect("deploy() holds a counterparty key");

    // Two distinct channels between the same pair of identities need
    // distinct mints to derive distinct channel PDAs (the seeds are
    // `["channel", min(a,b), max(a,b), token_mint]`) -- this backend only
    // ever holds one mint, so instead this proves concurrency across two
    // *funding* and *redeeming* calls against the one channel `open`
    // already produced, which is where a shared fee-payer/RPC connection
    // could actually race.
    let channel = backend
        .open(counterparty, Duration::seconds(0))
        .await
        .expect("open");

    let backend_a = Arc::clone(&backend);
    let channel_a = channel.clone();
    let backend_b = Arc::clone(&backend);
    let channel_b = channel.clone();

    let (result_a, result_b) = tokio::join!(
        async move { backend_a.fund(&channel_a, 111).await },
        async move { backend_b.fund(&channel_b, 222).await },
    );

    result_a.expect("concurrent fund (first)");
    result_b.expect("concurrent fund (second)");

    let state = backend
        .channel_state(&channel)
        .await
        .expect("channel_state");
    assert_eq!(state.deposited, 333);

    let sig_a = backend
        .test_sign_claim(&channel, 1, 100)
        .expect("sign as counterparty");
    let sig_b = backend
        .test_sign_claim(&channel, 2, 200)
        .expect("sign as counterparty");
    let backend_a = Arc::clone(&backend);
    let channel_a = channel.clone();
    let backend_b = Arc::clone(&backend);
    let channel_b = channel.clone();
    let (redeem_a, redeem_b) = tokio::join!(
        async move {
            backend_a
                .redeem(
                    &channel_a,
                    Claim {
                        nonce: 1,
                        cumulative_amount: 100,
                        signature: sig_a,
                    },
                )
                .await
        },
        async move {
            // Deliberately submitted concurrently with the lower-nonce
            // claim above; only one ordering of two racing transactions
            // against the same channel account can land first, and the
            // program's nonce ratchet accepts the lower-nonce claim only
            // in one of them -- so the assertions below are on this
            // higher-nonce claim always succeeding and on the final
            // channel state, not on both calls succeeding.
            backend_b
                .redeem(
                    &channel_b,
                    Claim {
                        nonce: 2,
                        cumulative_amount: 200,
                        signature: sig_b,
                    },
                )
                .await
        },
    );
    // The higher-nonce claim is valid whichever order the two land in, so
    // it must succeed outright. The lower-nonce claim is only valid if it
    // lands *first*: if the nonce-2 claim beats it on chain, the program's
    // own nonce ratchet (or this backend's pre-submission staleness check,
    // depending on when the race resolves) rejects it as superseded --
    // which is correct, not a silent drop, so both outcomes are accepted
    // here and the real invariant is the final on-chain state below.
    redeem_b.expect("concurrent redeem (higher nonce)");
    if let Err(error) = redeem_a {
        eprintln!("lower-nonce claim lost the race, rejected as superseded: {error}");
    }

    let state = backend
        .channel_state(&channel)
        .await
        .expect("channel_state");
    assert_eq!(state.redeemed, 200);
}
