//! One contract suite (ADR 0007): the definition of the [`SettlementBackend`]
//! port, written so any implementation -- in-process or, per ADR 0002, a
//! real chain in a separate crate -- can be run against it and is not an
//! implementation of the port until it passes unmodified.
//!
//! Gated behind the `test-util` feature (rather than `#[cfg(test)]` alone)
//! because, unlike `connector-runtime`'s `PeerTransport` contract suite,
//! this port's implementations live in separate crates
//! (`connector-settlement-evm`, `connector-settlement-solana`): a suite
//! hidden behind `#[cfg(test)]` is invisible outside this crate's own test
//! build, so those crates could never hold their implementation to it.
//! They add this crate under `[dev-dependencies]` with `features =
//! ["test-util"]` and call [`assert_upholds_the_contract`] from their own
//! tests instead.

use std::future::Future;
use std::sync::Arc;

use chrono::Duration;

use crate::port::{ChannelId, ChannelStatus, Claim, SettlementBackend, SettlementError};

/// Run every assertion the [`SettlementBackend`] port makes, against a
/// freshly built implementation from `build`. A conforming implementation
/// passes this function without modification -- that unmodified pass is
/// what "upholds the contract" means (ADR 0007).
///
/// `build` also hands back two counterparty identities (issue #574) rather
/// than this suite hardcoding its own: a plain ASCII peer name is not
/// expressible as a real signing address on every chain this port has an
/// implementation for (an EVM counterparty must recover from a signature,
/// a Solana one is a 32-byte pubkey), so an implementation whose chain
/// requires a real key supplies one instead of being handed a name it has
/// no key for.
pub async fn assert_upholds_the_contract<F, Fut>(build: F)
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = (Arc<dyn SettlementBackend>, Vec<u8>, Vec<u8>)>,
{
    let (backend, counterparty, other_counterparty) = build().await;
    let timeout = Duration::seconds(3600);

    // Opening a channel reports it open, unfunded, to the counterparty given.
    let channel = backend
        .open(counterparty.clone(), timeout)
        .await
        .expect("open");
    let state = backend
        .channel_state(&channel)
        .await
        .expect("channel_state");
    assert_eq!(state.status, ChannelStatus::Open);
    assert_eq!(state.deposited, 0);
    assert_eq!(state.redeemed, 0);
    assert_eq!(state.counterparty, counterparty);

    // Funding increases the deposited balance, cumulatively across calls.
    let state = backend.fund(&channel, 100).await.expect("fund");
    assert_eq!(state.deposited, 100);
    let state = backend.fund(&channel, 50).await.expect("fund");
    assert_eq!(state.deposited, 150);

    // Redeeming a valid claim moves the redeemed total to the claim's
    // cumulative amount. The deposit is untouched -- it is the channel's
    // total funding, not what remains unredeemed.
    let state = backend
        .redeem(
            &channel,
            Claim {
                nonce: 1,
                cumulative_amount: 60,
                signature: vec![1],
            },
        )
        .await
        .expect("redeem");
    assert_eq!(state.redeemed, 60);
    assert_eq!(state.deposited, 150);

    // A later claim supersedes an earlier one: redeeming again for a
    // higher cumulative amount succeeds and moves the total further.
    let state = backend
        .redeem(
            &channel,
            Claim {
                nonce: 2,
                cumulative_amount: 120,
                signature: vec![2],
            },
        )
        .await
        .expect("redeem");
    assert_eq!(state.redeemed, 120);

    // A claim that does not supersede the highest one redeemed so far is
    // rejected outright (ADR 0005: only the highest-nonce claim is ever
    // honored) rather than silently ignored or double-paid. Same nonce as
    // the claim just redeemed, matching the amount replay this asserts --
    // `connector-settlement-evm`/`-solana` settle through contracts with no
    // nonce field of their own yet (issue #566), so this exact replay is
    // the one nonce/amount scenario this shared suite can hold every
    // backend to identically; `InMemorySettlementBackend`'s own,
    // additional nonce-ordering rule is exercised separately in
    // `in_memory.rs`'s own tests.
    let err = backend
        .redeem(
            &channel,
            Claim {
                nonce: 2,
                cumulative_amount: 120,
                signature: vec![3],
            },
        )
        .await
        .unwrap_err();
    assert_eq!(
        err,
        SettlementError::StaleClaim {
            claimed: 120,
            already_redeemed: 120,
        }
    );

    // A claim beyond the channel's funded balance is rejected -- a
    // redeemer is never paid more than was actually deposited.
    let err = backend
        .redeem(
            &channel,
            Claim {
                nonce: 3,
                cumulative_amount: 1_000,
                signature: vec![4],
            },
        )
        .await
        .unwrap_err();
    assert_eq!(
        err,
        SettlementError::InsufficientChannelBalance {
            requested: 1_000,
            deposited: 150,
        }
    );

    // Closing a channel starts its challenge period (issue #574): its own
    // state reports Closed, that status is durable when queried back
    // separately, funding is refused, and it cannot be closed a second
    // time -- but redeeming during the window that follows still
    // succeeds. Forfeiting that window (the old behaviour here) hands the
    // whole outstanding balance back to whichever party closed the
    // channel; `TokenNetwork.claimFromChannel` deliberately accepts both
    // `Opened` and `Closed` for exactly this reason
    // (`packages/contracts/src/TokenNetwork.sol:262-263`, `:273`).
    let state = backend.close(&channel).await.expect("close");
    assert_eq!(state.status, ChannelStatus::Closed);

    let state = backend
        .channel_state(&channel)
        .await
        .expect("channel_state");
    assert_eq!(state.status, ChannelStatus::Closed);

    let err = backend.fund(&channel, 10).await.unwrap_err();
    assert_eq!(err, SettlementError::ChannelClosed(channel.clone()));

    // A later, still-superseding claim redeems during the challenge
    // window -- this is the window's whole point (issue #574).
    let state = backend
        .redeem(
            &channel,
            Claim {
                nonce: 4,
                cumulative_amount: 121,
                signature: vec![5],
            },
        )
        .await
        .expect("redeem during the challenge window");
    assert_eq!(state.redeemed, 121);

    let err = backend.close(&channel).await.unwrap_err();
    assert_eq!(err, SettlementError::ChannelClosed(channel.clone()));

    // `timeout` above is a full hour and no real time has elapsed since
    // `close` -- settling this channel now must fail with the named
    // "not yet due" error (issue #574), not a generic backend string.
    // `MIN_SETTLEMENT_TIMEOUT` on the real `TokenNetwork` this port will
    // eventually retarget onto (issue #566) is itself one hour
    // (`TokenNetwork.sol:31`); observing that timeout actually elapse
    // would need a chain whose clock this suite can advance, which is
    // deliberately not what the scenario below asks for.
    let err = backend.settle(&channel).await.unwrap_err();
    assert_eq!(err, SettlementError::SettlementNotYetDue(channel.clone()));

    // A channel opened with no challenge period at all becomes settleable
    // the instant it is closed -- proving `settle` genuinely reaches a
    // terminal, no-longer-redeemable state (not just that it refuses
    // early) without this suite waiting out a real timeout.
    let immediate = backend
        .open(counterparty.clone(), Duration::zero())
        .await
        .expect("open with no challenge period");
    backend.fund(&immediate, 200).await.expect("fund");
    backend.close(&immediate).await.expect("close");
    let state = backend.settle(&immediate).await.expect("settle");
    assert_eq!(state.status, ChannelStatus::Settled);

    let err = backend
        .redeem(
            &immediate,
            Claim {
                nonce: 1,
                cumulative_amount: 50,
                signature: vec![6],
            },
        )
        .await
        .unwrap_err();
    assert_eq!(err, SettlementError::ChannelSettled(immediate.clone()));

    let err = backend.settle(&immediate).await.unwrap_err();
    assert_eq!(err, SettlementError::ChannelSettled(immediate));

    // A channel id from one open() call names only that channel -- a
    // second channel to a different counterparty has its own independent,
    // freshly-unfunded state.
    let other = backend
        .open(other_counterparty.clone(), timeout)
        .await
        .expect("open");
    assert_ne!(other, channel);
    let other_state = backend.channel_state(&other).await.expect("channel_state");
    assert_eq!(other_state.status, ChannelStatus::Open);
    assert_eq!(other_state.deposited, 0);

    // Operating on an id nothing ever opened is reported, not panicked.
    let missing = ChannelId("does-not-exist".to_string());
    let err = backend.channel_state(&missing).await.unwrap_err();
    assert_eq!(err, SettlementError::ChannelNotFound(missing.clone()));
    let err = backend.fund(&missing, 1).await.unwrap_err();
    assert_eq!(err, SettlementError::ChannelNotFound(missing.clone()));
    let err = backend.close(&missing).await.unwrap_err();
    assert_eq!(err, SettlementError::ChannelNotFound(missing.clone()));
    let err = backend.settle(&missing).await.unwrap_err();
    assert_eq!(err, SettlementError::ChannelNotFound(missing));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::InMemorySettlementBackend;

    #[tokio::test]
    async fn in_memory_settlement_backend_upholds_the_contract() {
        assert_upholds_the_contract(|| async {
            (
                Arc::new(InMemorySettlementBackend::new()) as Arc<dyn SettlementBackend>,
                b"counterparty-a".to_vec(),
                b"counterparty-b".to_vec(),
            )
        })
        .await;
    }
}
