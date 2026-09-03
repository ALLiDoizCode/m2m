//! A reverted transaction is a distinct outcome from a mined one, and this
//! backend must say so explicitly rather than assume "a receipt came back"
//! means "the operation happened" (issue #425: "confirmation ...  handled
//! explicitly rather than assumed", "a failed or reverted settlement
//! transaction leaves recoverable state"). Every `SettlementBackend` method
//! here checks its own preconditions client-side before ever sending a
//! transaction, so the only way a transaction we send still reverts on
//! chain is a genuine race: two calls both read the same pre-state, both
//! pass their own pre-flight check, and only one of them can actually land
//! first.

mod support;

use std::sync::Arc;

use chrono::Duration;
use connector_settlement::{Claim, SettlementBackend, SettlementError};
use connector_settlement_evm::EvmSettlementBackend;
use connector_signer::{derive_evm_address, evm_balance_proof_digest, EvmBalanceProof};
use libsecp256k1::{PublicKey, SecretKey};

use support::{
    channel_id_bytes, require_anvil, sign_evm, Anvil, ANVIL_CHAIN_ID, DEPLOYER_PRIVATE_KEY,
};

/// Two concurrent `redeem` calls against the same channel, submitting the
/// *same* claim: both read the channel's pre-redemption state (redeemed =
/// 0) before either sends its transaction, so both pass the client-side
/// `StaleClaim` check and both submit. Only the first to land actually
/// redeems; the second's transaction reverts on chain, because the
/// contract's own nonce check now sees `balanceProof.nonce <=
/// counterpartyState.nonce` (`TokenNetwork.sol`'s `InvalidNonce`). Before
/// this backend checked `receipt.status`,
/// that revert was invisible: `confirm` returned `Ok` regardless, and the
/// loser would have reported the channel's real (unaffected) state as if
/// its own redemption had succeeded.
#[tokio::test]
async fn a_racing_redeem_that_reverts_on_chain_is_reported_as_an_explicit_error() {
    if !require_anvil() {
        return;
    }

    let anvil = Anvil::spawn().await;
    let token =
        EvmSettlementBackend::deploy_mock_token(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
            .await
            .expect("deploy mock USDC");
    let backend = Arc::new(
        EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
            .await
            .expect("deploy a TokenNetwork through a fresh registry"),
    );
    let token_network_address = backend.address().to_fixed_bytes();

    let counterparty_secret = SecretKey::parse(&[5u8; 32]).expect("valid secret key");
    let counterparty_public = PublicKey::from_secret_key(&counterparty_secret);
    let counterparty = derive_evm_address(&counterparty_public.serialize()).to_vec();

    let channel = backend
        .open(counterparty, Duration::seconds(3600))
        .await
        .expect("open");
    // The counterparty signs the claim below, so it is their side that has
    // to hold the collateral (issue #1118).
    backend
        .fund_counterparty(&channel, 1_000)
        .await
        .expect("fund the counterparty's side");

    let claim = || {
        let proof = EvmBalanceProof {
            channel_id: channel_id_bytes(&channel.0),
            nonce: 1,
            transferred_amount: 400,
            locked_amount: 0,
            locks_root: [0u8; 32],
            chain_id: ANVIL_CHAIN_ID,
            token_network_address,
        };
        Claim {
            nonce: 1,
            cumulative_amount: 400,
            signature: sign_evm(&counterparty_secret, &evm_balance_proof_digest(&proof)),
        }
    };

    let backend_a = Arc::clone(&backend);
    let channel_a = channel.clone();
    let backend_b = Arc::clone(&backend);
    let channel_b = channel.clone();

    let (result_a, result_b) = tokio::join!(
        async move { backend_a.redeem(&channel_a, claim()).await },
        async move { backend_b.redeem(&channel_b, claim()).await },
    );

    // Exactly one of the two racing redemptions succeeded -- never both
    // (that would mean the delta was paid out twice) and never neither.
    let outcomes = [&result_a, &result_b];
    let successes = outcomes.iter().filter(|r| r.is_ok()).count();
    let failures = outcomes
        .iter()
        .filter(|r| {
            matches!(
                r,
                Err(SettlementError::Backend(message)) if message.contains("reverted")
            )
        })
        .count();
    assert_eq!(successes, 1, "expected exactly one redemption to succeed");
    assert_eq!(
        failures, 1,
        "expected the losing redemption to report an explicit revert, not silent success"
    );

    // Recoverable: the channel's real state reflects only the one
    // redemption that actually happened, and a fresh, correctly-targeted
    // redemption still works -- nothing about the reverted transaction
    // left this channel stuck.
    let state = backend.channel_state(&channel).await.expect("read state");
    assert_eq!(state.redeemed, 400);

    let proof = EvmBalanceProof {
        channel_id: channel_id_bytes(&channel.0),
        nonce: 2,
        transferred_amount: 900,
        locked_amount: 0,
        locks_root: [0u8; 32],
        chain_id: ANVIL_CHAIN_ID,
        token_network_address,
    };
    let state = backend
        .redeem(
            &channel,
            Claim {
                nonce: 2,
                cumulative_amount: 900,
                signature: sign_evm(&counterparty_secret, &evm_balance_proof_digest(&proof)),
            },
        )
        .await
        .expect("a subsequent genuine redemption still succeeds");
    assert_eq!(state.redeemed, 900);
}
