use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use async_trait::async_trait;
use chrono::Duration;

use crate::port::{
    ChannelId, ChannelState, ChannelStatus, Claim, SettlementBackend, SettlementError,
};

struct StoredChannel {
    counterparty: Vec<u8>,
    status: ChannelStatus,
    deposited: u128,
    redeemed: u128,
    redeemed_nonce: u64,
}

impl StoredChannel {
    fn state(&self, id: &ChannelId) -> ChannelState {
        ChannelState {
            id: id.clone(),
            counterparty: self.counterparty.clone(),
            status: self.status,
            deposited: self.deposited,
            redeemed: self.redeemed,
        }
    }
}

/// The in-memory [`SettlementBackend`]: channel state lives only in this
/// process and nothing is ever submitted to a chain. This is the fake this
/// workspace's own tests use, and the first implementation to pass the
/// contract suite in [`crate::contract`] (ADR 0007) -- proving the port's
/// shape is satisfiable before any real chain code exists.
#[derive(Default)]
pub struct InMemorySettlementBackend {
    channels: Mutex<HashMap<ChannelId, StoredChannel>>,
    next_id: AtomicU64,
}

impl InMemorySettlementBackend {
    pub fn new() -> Self {
        InMemorySettlementBackend::default()
    }

    fn channels(&self) -> MutexGuard<'_, HashMap<ChannelId, StoredChannel>> {
        self.channels
            .lock()
            .expect("InMemorySettlementBackend lock poisoned")
    }

    /// Look up `id`, refusing a closed channel to every write operation
    /// (`f`) with the same [`SettlementError::ChannelClosed`] regardless of
    /// which one called -- close is terminal, not a per-method concern.
    fn with_open_channel<T>(
        &self,
        id: &ChannelId,
        f: impl FnOnce(&mut StoredChannel) -> Result<T, SettlementError>,
    ) -> Result<T, SettlementError> {
        let mut channels = self.channels();
        let channel = channels
            .get_mut(id)
            .ok_or_else(|| SettlementError::ChannelNotFound(id.clone()))?;
        if channel.status == ChannelStatus::Closed {
            return Err(SettlementError::ChannelClosed(id.clone()));
        }
        f(channel)
    }
}

#[async_trait]
impl SettlementBackend for InMemorySettlementBackend {
    async fn open(
        &self,
        counterparty: Vec<u8>,
        _settlement_timeout: Duration,
    ) -> Result<ChannelId, SettlementError> {
        let id = ChannelId(format!(
            "in-memory-channel-{}",
            self.next_id.fetch_add(1, Ordering::SeqCst)
        ));
        self.channels().insert(
            id.clone(),
            StoredChannel {
                counterparty,
                status: ChannelStatus::Open,
                deposited: 0,
                redeemed: 0,
                redeemed_nonce: 0,
            },
        );
        Ok(id)
    }

    async fn fund(
        &self,
        channel: &ChannelId,
        amount: u128,
    ) -> Result<ChannelState, SettlementError> {
        self.with_open_channel(channel, |c| {
            c.deposited += amount;
            Ok(c.state(channel))
        })
    }

    async fn redeem(
        &self,
        channel: &ChannelId,
        claim: Claim,
    ) -> Result<ChannelState, SettlementError> {
        self.with_open_channel(channel, |c| {
            if claim.cumulative_amount <= c.redeemed {
                return Err(SettlementError::StaleClaim {
                    claimed: claim.cumulative_amount,
                    already_redeemed: c.redeemed,
                });
            }
            if claim.cumulative_amount > c.deposited {
                return Err(SettlementError::InsufficientChannelBalance {
                    requested: claim.cumulative_amount,
                    deposited: c.deposited,
                });
            }
            // Checked after `cumulative_amount`, not before: the two rules
            // are independent (a claim's amount can supersede while its
            // nonce does not), and ordering the amount check first keeps
            // a claim that merely replays the last one accepted -- same
            // nonce, same amount -- reported as `StaleClaim`, matching what
            // `connector-settlement-evm`/`-solana` also report for that
            // same replay today, since neither backend's contract has a
            // nonce field to check against yet (issue #566).
            if claim.nonce <= c.redeemed_nonce {
                return Err(SettlementError::StaleNonce {
                    claimed: claim.nonce,
                    already_redeemed: c.redeemed_nonce,
                });
            }
            c.redeemed = claim.cumulative_amount;
            c.redeemed_nonce = claim.nonce;
            Ok(c.state(channel))
        })
    }

    async fn close(&self, channel: &ChannelId) -> Result<ChannelState, SettlementError> {
        self.with_open_channel(channel, |c| {
            c.status = ChannelStatus::Closed;
            Ok(c.state(channel))
        })
    }

    async fn channel_state(&self, channel: &ChannelId) -> Result<ChannelState, SettlementError> {
        let channels = self.channels();
        let stored = channels
            .get(channel)
            .ok_or_else(|| SettlementError::ChannelNotFound(channel.clone()))?;
        Ok(stored.state(channel))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    /// Issue #573: a real chain enforces nonce ordering independently of
    /// amount (`TokenNetwork.claimFromChannel`'s `balanceProof.nonce >
    /// counterpartyState.nonce`), so a claim whose amount happens to
    /// supersede the last one redeemed must still be refused if its nonce
    /// does not -- and refused distinguishably from `StaleClaim`, which is
    /// [`crate::contract::assert_upholds_the_contract`]'s own scenario for
    /// a claim that fails on amount alone. This is not part of that shared
    /// suite because `connector-settlement-evm` and `connector-settlement-solana`
    /// settle through contracts with no nonce field yet (issue #566) and
    /// cannot enforce this client-side until that lands; this backend, with
    /// no such constraint, enforces it today.
    #[tokio::test]
    async fn a_claim_whose_nonce_does_not_advance_is_refused_distinctly_from_a_stale_amount() {
        let backend = InMemorySettlementBackend::new();
        let channel = backend
            .open(b"counterparty-a".to_vec(), Duration::seconds(3600))
            .await
            .expect("open");
        backend.fund(&channel, 1_000).await.expect("fund");

        backend
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

        // A higher cumulative amount alone is not enough: this claim's
        // nonce (1) does not exceed the one just redeemed (also 1).
        let err = backend
            .redeem(
                &channel,
                Claim {
                    nonce: 1,
                    cumulative_amount: 120,
                    signature: vec![2],
                },
            )
            .await
            .unwrap_err();
        assert_eq!(
            err,
            SettlementError::StaleNonce {
                claimed: 1,
                already_redeemed: 1,
            }
        );

        // Neither the redeemed amount nor the redeemed nonce moved.
        let state = backend
            .channel_state(&channel)
            .await
            .expect("channel_state");
        assert_eq!(state.redeemed, 60);

        // A genuinely advancing claim -- both nonce and amount -- still
        // succeeds afterward.
        let state = backend
            .redeem(
                &channel,
                Claim {
                    nonce: 2,
                    cumulative_amount: 120,
                    signature: vec![3],
                },
            )
            .await
            .expect("redeem");
        assert_eq!(state.redeemed, 120);
    }
}
