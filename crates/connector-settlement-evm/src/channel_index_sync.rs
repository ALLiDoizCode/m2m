//! Drives an [`EvmChannelIndex`] from a real `TokenNetwork`'s own logs
//! (issue #661): backfill in bounded `eth_getLogs` ranges up to
//! `chain_head - confirmations`, then poll for more as the chain advances.
//! The state machine [`EvmChannelIndex`] applies is chain-agnostic and
//! tested without a chain at all -- this module is the one place that
//! actually queries and decodes logs, kept separate for exactly that
//! reason.
//!
//! No `eth_subscribe`: this workspace standardizes on `Provider<Http>`
//! everywhere (`EvmSettlementBackend::build_client`), and this syncer
//! follows that rather than introducing the only WS-transport consumer in
//! the codebase for one feature.

use std::sync::Arc;
use std::time::Duration;

use ethers::contract::{ContractError, EthEvent};
use ethers::providers::{Http, Middleware, Provider, ProviderError};
use ethers::types::Address;

use crate::bindings::token_network::{
    ChannelClosedByExpiryFilter, ChannelNewDepositFilter, ChannelOpenedFilter,
    ChannelSettledFilter, TokenNetwork as TokenNetworkContract,
};
use crate::channel_index::{
    ChannelIndexEvent, EvmChannelIndex, EvmChannelIndexError, OrderedChannelIndexEvent,
};

/// Widest single `eth_getLogs` range this syncer asks for in one request
/// (issue #661 decision point 3: "backfill in bounded block ranges" --
/// `eth_getLogs` has provider-imposed range caps). Comfortably inside a
/// public provider's typical cap (e.g. Alchemy's free-tier 2,000-block
/// limit) so this never needs a per-deployment tuning knob.
const MAX_BLOCK_RANGE: u64 = 2_000;

/// How long a caught-up syncer waits before checking chain head again, and
/// how long a failed attempt waits before retrying.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum ChannelIndexSyncError {
    #[error("channel index sync could not build an RPC client for {rpc_url}: {reason}")]
    Client { rpc_url: String, reason: String },
    #[error("channel index sync could not read the chain: {0}")]
    Provider(#[from] ProviderError),
    #[error("channel index sync could not read a TokenNetwork log: {0}")]
    Decode(String),
    #[error(transparent)]
    Index(#[from] EvmChannelIndexError),
}

/// Reads `TokenNetwork`'s own `ChannelOpened`/`ChannelNewDeposit`/
/// `ChannelSettled`/`ChannelClosedByExpiry` logs and folds them into an
/// [`EvmChannelIndex`]. Holds no signing key and sends no transaction -- a
/// plain `Provider<Http>`, never [`crate::EvmSettlementBackend`]'s signing
/// client, since this syncer only ever reads.
pub struct EvmChannelIndexSyncer {
    contract: TokenNetworkContract<Provider<Http>>,
    confirmations: u64,
    from_block: u64,
}

impl EvmChannelIndexSyncer {
    /// `confirmations` must be at least 1 -- `crate::config` (via
    /// `EvmSettlementConfig::channel_index_confirmations`) already refuses a
    /// depth of `0` at config load time, so this is a second, defensive
    /// check rather than the primary one.
    pub fn new(
        rpc_url: &str,
        contract_address: Address,
        confirmations: u64,
        from_block: u64,
    ) -> Result<Self, ChannelIndexSyncError> {
        let provider = Provider::<Http>::try_from(rpc_url)
            .map_err(|source| ChannelIndexSyncError::Client {
                rpc_url: rpc_url.to_string(),
                reason: source.to_string(),
            })?
            .interval(Duration::from_millis(100));
        let contract = TokenNetworkContract::new(contract_address, Arc::new(provider));
        Ok(EvmChannelIndexSyncer {
            contract,
            confirmations: confirmations.max(1),
            from_block,
        })
    }

    /// One backfill/poll step: apply everything between this index's
    /// checkpoint and `chain_head - confirmations`, in at most
    /// [`MAX_BLOCK_RANGE`] blocks. Returns how many blocks were newly
    /// applied -- `0` means either there is nothing new deep enough yet, or
    /// the provider's own head has not advanced past the confirmation
    /// window. Never blocks past one bounded range, so a syncer far behind
    /// catches up in several short calls rather than one long one holding a
    /// lookup racing in on `index` for an unbounded time.
    pub async fn sync_once(&self, index: &EvmChannelIndex) -> Result<u64, ChannelIndexSyncError> {
        let head = self.contract.client().get_block_number().await?.as_u64();
        let confirmed_head = head.saturating_sub(self.confirmations);
        let start = match index.last_indexed_block() {
            Some(checkpoint) => checkpoint + 1,
            None => self.from_block,
        };
        if start > confirmed_head {
            return Ok(0);
        }
        let end = start
            .saturating_add(MAX_BLOCK_RANGE - 1)
            .min(confirmed_head);
        let events = self.query_range(start, end).await?;
        index.apply(events, end)?;
        Ok(end - start + 1)
    }

    /// Every log this index folds in, over `from..=to`. One `eth_getLogs`
    /// per event type -- the four topics have nothing in common to filter
    /// on in a single query -- gathered unordered, since
    /// [`EvmChannelIndex::apply`] sorts the whole batch into chain order
    /// before applying any of it.
    async fn query_range(
        &self,
        from: u64,
        to: u64,
    ) -> Result<Vec<OrderedChannelIndexEvent>, ChannelIndexSyncError> {
        let mut events = Vec::new();
        self.collect_logs(from, to, &mut events, |log: ChannelOpenedFilter| {
            ChannelIndexEvent::Opened {
                channel_id: log.channel_id,
                participant1: log.participant_1,
                participant2: log.participant_2,
            }
        })
        .await?;
        self.collect_logs(from, to, &mut events, |log: ChannelNewDepositFilter| {
            ChannelIndexEvent::NewDeposit {
                channel_id: log.channel_id,
                participant: log.participant,
                total_deposit: log.total_deposit,
            }
        })
        .await?;
        self.collect_logs(from, to, &mut events, |log: ChannelSettledFilter| {
            ChannelIndexEvent::Settled {
                channel_id: log.channel_id,
            }
        })
        .await?;
        self.collect_logs(from, to, &mut events, |log: ChannelClosedByExpiryFilter| {
            ChannelIndexEvent::ClosedByExpiry {
                channel_id: log.channel_id,
            }
        })
        .await?;
        Ok(events)
    }

    /// One event type's logs over `from..=to`, decoded by `into` and tagged
    /// with the `(block_number, log_index)` position the chain gave them.
    async fn collect_logs<E, F>(
        &self,
        from: u64,
        to: u64,
        events: &mut Vec<OrderedChannelIndexEvent>,
        into: F,
    ) -> Result<(), ChannelIndexSyncError>
    where
        E: EthEvent,
        F: Fn(E) -> ChannelIndexEvent,
    {
        let logs = self
            .contract
            .event::<E>()
            .from_block(from)
            .to_block(to)
            .query_with_meta()
            .await
            .map_err(decode_error)?;
        events.extend(
            logs.into_iter()
                .map(|(log, meta)| OrderedChannelIndexEvent {
                    block_number: meta.block_number.as_u64(),
                    log_index: meta.log_index.as_u64(),
                    event: into(log),
                }),
        );
        Ok(())
    }

    /// Backfill-then-poll forever: never returns except by being dropped.
    /// Meant to be `tokio::spawn`'d, never `.await`'d on the startup path --
    /// issue #661's own acceptance criterion is that a cold-start backfill
    /// must not block the node from serving traffic.
    ///
    /// A failed attempt (an unreachable RPC endpoint, say) is logged at
    /// `warn` and retried after `poll_interval`; it never panics and never
    /// stops the loop, since a channel this index cannot currently reach
    /// still has the existing direct chain-read fallback to lean on.
    pub async fn run(self, index: Arc<EvmChannelIndex>, poll_interval: Duration) {
        loop {
            match self.sync_once(&index).await {
                Ok(0) => tokio::time::sleep(poll_interval).await,
                // Progress was made and there may be more behind it --
                // loop again immediately rather than waiting out a poll
                // interval per bounded range while catching up.
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(
                        error = %error,
                        "channel index sync failed to advance; affected channels fall back to \
                         a direct chain read until this recovers"
                    );
                    tokio::time::sleep(poll_interval).await;
                }
            }
        }
    }
}

fn decode_error<M: Middleware>(error: ContractError<M>) -> ChannelIndexSyncError {
    ChannelIndexSyncError::Decode(error.to_string())
}
