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

use support::{require_anvil, Anvil, DEPLOYER_PRIVATE_KEY};

/// Two concurrent `redeem` calls against the same channel, submitting the
/// *same* claim: both read the channel's pre-redemption state (redeemed =
/// 0) before either sends its transaction, so both pass the client-side
/// `StaleClaim` check and both submit. Only the first to land actually
/// redeems; the second's transaction reverts on chain, because the
/// contract's own check now sees `cumulativeAmount <= channel.redeemed`.
/// Before this backend checked `receipt.status`, that revert was invisible:
/// `confirm` returned `Ok` regardless, and the loser would have reported
/// the channel's real (unaffected) state as if its own redemption had
/// succeeded.
#[tokio::test]
async fn a_racing_redeem_that_reverts_on_chain_is_reported_as_an_explicit_error() {
    if !require_anvil() {
        return;
    }

    let anvil = Anvil::spawn().await;
    let backend = Arc::new(
        EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY)
            .await
            .expect("deploy SettlementChannel"),
    );

    let channel = backend
        .open(b"racing-redeem-peer".to_vec(), Duration::seconds(3600))
        .await
        .expect("open");
    backend.fund(&channel, 1_000).await.expect("fund");

    let claim = || Claim {
        cumulative_amount: 400,
        signature: vec![9],
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

    let state = backend
        .redeem(
            &channel,
            Claim {
                cumulative_amount: 900,
                signature: vec![9],
            },
        )
        .await
        .expect("a subsequent genuine redemption still succeeds");
    assert_eq!(state.redeemed, 900);
}
