//! EVM settlement backend (issue #459, ADR 0001, ADR 0002): a real,
//! chain-backed [`SettlementBackend`] driven against
//! `contracts/SettlementChannel.sol` -- a minimal native-ETH payment
//! channel with no `lockedAmount`/`locksRoot` fields (ADR 0004).
//!
//! Unlike [`connector_settlement::InMemorySettlementBackend`], this
//! backend holds no local channel state of its own: every
//! [`SettlementBackend`] method reads the chain fresh (via
//! `SettlementChannel::channelState`) before deciding what the port's
//! rules require, and mutates the chain via a real transaction only once
//! that check passes. This mirrors the "pre-flight, then submit" pattern
//! the existing TypeScript EVM provider already uses for its one
//! chain-specific precondition (`ChallengeNotExpiredError` before
//! `settleChannel`) -- checking client-side first, rather than relying on
//! decoding a reverted transaction's custom-error selector, keeps every
//! [`SettlementError`] variant the port's own contract suite exercises
//! (`ChannelNotFound`, `ChannelClosed`, `StaleClaim`,
//! `InsufficientChannelBalance`) exact, and reserves
//! [`SettlementError::Backend`] for genuine I/O failure (a dropped
//! transaction, an RPC error) rather than for rules this port already
//! names.

mod bindings;

use std::sync::Arc;

use async_trait::async_trait;
use chrono::Duration;
use ethers::middleware::nonce_manager::NonceManagerMiddleware;
use ethers::middleware::{Middleware, SignerMiddleware};
use ethers::providers::{Http, JsonRpcClient, PendingTransaction, Provider, ProviderError};
use ethers::signers::{LocalWallet, Signer as EvmSigner};
use ethers::types::{Address, Bytes, TransactionReceipt, U256};

use connector_settlement::{
    ChannelId, ChannelState, ChannelStatus, Claim, SettlementBackend, SettlementError,
};

use bindings::{ChannelOpenedFilter, SettlementChannel as SettlementChannelContract};

/// The signing client every contract call is made through, wrapped in a
/// [`NonceManagerMiddleware`] so that concurrent calls against the same
/// backend (every [`SettlementBackend`] method takes `&self`, so nothing
/// stops two calls racing) assign themselves distinct, correctly ordered
/// nonces instead of both reading the same "pending" nonce from the node
/// and conflicting when both land.
type EvmClient = NonceManagerMiddleware<SignerMiddleware<Provider<Http>, LocalWallet>>;

/// A [`SettlementBackend`] backed by a real `SettlementChannel` contract
/// instance on an EVM chain.
pub struct EvmSettlementBackend {
    contract: SettlementChannelContract<EvmClient>,
}

impl EvmSettlementBackend {
    /// Bind to an already-deployed `SettlementChannel` at
    /// `contract_address`, signing every transaction with `private_key`
    /// (a hex-encoded secp256k1 key, `0x`-prefix optional).
    pub async fn connect(
        rpc_url: &str,
        private_key: &str,
        contract_address: Address,
    ) -> Result<Self, SettlementError> {
        let client = Arc::new(build_client(rpc_url, private_key).await?);
        Ok(Self {
            contract: SettlementChannelContract::new(contract_address, client),
        })
    }

    /// Deploy a fresh `SettlementChannel` instance, signed and paid for by
    /// `private_key`, and bind to it. Used by this crate's own tests and
    /// by whichever operator tooling first needs to stand a new
    /// settlement contract up rather than point at an existing one.
    pub async fn deploy(rpc_url: &str, private_key: &str) -> Result<Self, SettlementError> {
        let client = Arc::new(build_client(rpc_url, private_key).await?);
        let contract = SettlementChannelContract::deploy(client, ())
            .map_err(backend_error)?
            .send()
            .await
            .map_err(backend_error)?;
        Ok(Self { contract })
    }

    /// The address this backend's `SettlementChannel` is deployed at.
    pub fn address(&self) -> Address {
        self.contract.address()
    }

    /// Resolve `channel` to the on-chain id it names, or
    /// [`SettlementError::ChannelNotFound`] if `channel`'s id was never
    /// assigned by a prior [`open`](SettlementBackend::open) call --
    /// either because it does not parse as one (e.g. a caller-fabricated
    /// id) or because it is not lower than the contract's own
    /// `channelCounter`, the one thing that only ever increases as
    /// channels are opened.
    async fn existing_channel_id(&self, channel: &ChannelId) -> Result<U256, SettlementError> {
        let id = U256::from_dec_str(&channel.0)
            .map_err(|_| SettlementError::ChannelNotFound(channel.clone()))?;
        let counter = self
            .contract
            .channel_counter()
            .call()
            .await
            .map_err(backend_error)?;
        if id >= counter {
            return Err(SettlementError::ChannelNotFound(channel.clone()));
        }
        Ok(id)
    }

    async fn read_state(
        &self,
        channel: &ChannelId,
        id: U256,
    ) -> Result<ChannelState, SettlementError> {
        let (
            _payer,
            counterparty,
            _payout_address,
            _settlement_timeout,
            deposited,
            redeemed,
            status,
        ) = self
            .contract
            .channel_state(id)
            .call()
            .await
            .map_err(backend_error)?;
        Ok(ChannelState {
            id: channel.clone(),
            counterparty: counterparty.to_vec(),
            status: if status == 0 {
                ChannelStatus::Open
            } else {
                ChannelStatus::Closed
            },
            deposited: deposited.as_u128(),
            redeemed: redeemed.as_u128(),
        })
    }

    /// Resolve `channel` to its on-chain id and current state, rejecting
    /// with [`SettlementError::ChannelClosed`] if it has already been
    /// closed -- the one precondition [`fund`](SettlementBackend::fund),
    /// [`redeem`](SettlementBackend::redeem) and
    /// [`close`](SettlementBackend::close) all share before doing their
    /// own, method-specific checks.
    async fn open_channel(
        &self,
        channel: &ChannelId,
    ) -> Result<(U256, ChannelState), SettlementError> {
        let id = self.existing_channel_id(channel).await?;
        let state = self.read_state(channel, id).await?;
        if state.status == ChannelStatus::Closed {
            return Err(SettlementError::ChannelClosed(channel.clone()));
        }
        Ok((id, state))
    }
}

async fn build_client(rpc_url: &str, private_key: &str) -> Result<EvmClient, SettlementError> {
    // ethers' default HTTP polling interval (7s) is tuned for mainnet block
    // times, not a fast-confirming chain -- every open/fund/redeem/close
    // otherwise pays that whole interval waiting for a receipt Anvil (or
    // any low-block-time chain) already mined.
    let provider = Provider::<Http>::try_from(rpc_url)
        .map_err(backend_error)?
        .interval(std::time::Duration::from_millis(100));
    let chain_id = provider
        .get_chainid()
        .await
        .map_err(backend_error)?
        .as_u64();
    let wallet: LocalWallet = private_key.parse().map_err(backend_error)?;
    let address = wallet.address();
    let signer = SignerMiddleware::new(provider, wallet.with_chain_id(chain_id));
    Ok(NonceManagerMiddleware::new(signer, address))
}

/// Derive a 20-byte EVM address for an arbitrary counterparty identifier.
/// A genuine peer address (already 20 bytes) passes through unchanged;
/// anything else (the port's own contract suite uses plain ASCII peer
/// names, not addresses) is hashed down to one -- deterministically, so
/// the same counterparty bytes always name the same on-chain address, and
/// validly, so `SettlementChannel.redeem`'s plain-ETH payout to it never
/// reverts for want of a real recipient.
fn counterparty_address(counterparty: &[u8]) -> Address {
    if counterparty.len() == 20 {
        Address::from_slice(counterparty)
    } else {
        Address::from_slice(&ethers::utils::keccak256(counterparty)[12..])
    }
}

fn backend_error<E: std::fmt::Display>(error: E) -> SettlementError {
    SettlementError::Backend(error.to_string())
}

async fn confirm<P: JsonRpcClient>(
    pending: PendingTransaction<'_, P>,
) -> Result<TransactionReceipt, SettlementError> {
    pending
        .await
        .map_err(|error: ProviderError| backend_error(error))?
        .ok_or_else(|| {
            SettlementError::Backend("transaction was dropped before mining".to_string())
        })
}

#[async_trait]
impl SettlementBackend for EvmSettlementBackend {
    async fn open(
        &self,
        counterparty: Vec<u8>,
        settlement_timeout: Duration,
    ) -> Result<ChannelId, SettlementError> {
        let payout_address = counterparty_address(&counterparty);
        let seconds = settlement_timeout.num_seconds().max(0) as u64;

        let call = self.contract.open(
            Bytes::from(counterparty),
            payout_address,
            U256::from(seconds),
        );
        let pending = call.send().await.map_err(backend_error)?;
        let receipt = confirm(pending).await?;

        for log in &receipt.logs {
            if let Ok(decoded) = self.contract.decode_event::<ChannelOpenedFilter>(
                "ChannelOpened",
                log.topics.clone(),
                log.data.clone(),
            ) {
                return Ok(ChannelId(decoded.channel_id.to_string()));
            }
        }
        Err(SettlementError::Backend(
            "open: no ChannelOpened event in the transaction receipt".to_string(),
        ))
    }

    async fn fund(
        &self,
        channel: &ChannelId,
        amount: u128,
    ) -> Result<ChannelState, SettlementError> {
        let (id, _state) = self.open_channel(channel).await?;

        let call = self.contract.fund(id).value(U256::from(amount));
        let pending = call.send().await.map_err(backend_error)?;
        confirm(pending).await?;

        self.read_state(channel, id).await
    }

    async fn redeem(
        &self,
        channel: &ChannelId,
        claim: Claim,
    ) -> Result<ChannelState, SettlementError> {
        let (id, state) = self.open_channel(channel).await?;
        if claim.cumulative_amount <= state.redeemed {
            return Err(SettlementError::StaleClaim {
                claimed: claim.cumulative_amount,
                already_redeemed: state.redeemed,
            });
        }
        if claim.cumulative_amount > state.deposited {
            return Err(SettlementError::InsufficientChannelBalance {
                requested: claim.cumulative_amount,
                deposited: state.deposited,
            });
        }

        let call = self.contract.redeem(
            id,
            U256::from(claim.cumulative_amount),
            Bytes::from(claim.signature),
        );
        let pending = call.send().await.map_err(backend_error)?;
        confirm(pending).await?;

        self.read_state(channel, id).await
    }

    async fn close(&self, channel: &ChannelId) -> Result<ChannelState, SettlementError> {
        let (id, _state) = self.open_channel(channel).await?;

        let call = self.contract.close(id);
        let pending = call.send().await.map_err(backend_error)?;
        confirm(pending).await?;

        self.read_state(channel, id).await
    }

    async fn channel_state(&self, channel: &ChannelId) -> Result<ChannelState, SettlementError> {
        let id = self.existing_channel_id(channel).await?;
        self.read_state(channel, id).await
    }
}
