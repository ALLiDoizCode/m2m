use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

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

    /// Look up `id`, refusing a closed channel to every write operation
    /// (`f`) with the same [`SettlementError::ChannelClosed`] regardless of
    /// which one called -- close is terminal, not a per-method concern.
    fn with_open_channel<T>(
        &self,
        id: &ChannelId,
        f: impl FnOnce(&mut StoredChannel) -> Result<T, SettlementError>,
    ) -> Result<T, SettlementError> {
        let mut channels = self
            .channels
            .lock()
            .expect("InMemorySettlementBackend lock poisoned");
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
        self.channels
            .lock()
            .expect("InMemorySettlementBackend lock poisoned")
            .insert(
                id.clone(),
                StoredChannel {
                    counterparty,
                    status: ChannelStatus::Open,
                    deposited: 0,
                    redeemed: 0,
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
            c.redeemed = claim.cumulative_amount;
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
        let channels = self
            .channels
            .lock()
            .expect("InMemorySettlementBackend lock poisoned");
        let stored = channels
            .get(channel)
            .ok_or_else(|| SettlementError::ChannelNotFound(channel.clone()))?;
        Ok(stored.state(channel))
    }
}
