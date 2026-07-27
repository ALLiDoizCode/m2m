//! Solana settlement backend (issue #428, ADR 0001, ADR 0002): a real,
//! chain-backed [`SettlementBackend`] driven against
//! `connector-settlement-solana-program` -- a purpose-built, native-SOL
//! payment channel program (see that crate's docs for why it is a fresh
//! program rather than a reuse of the legacy `packages/solana-program`).
//! This is the port's second real implementation, after
//! `connector-settlement-evm` (#459), and proves the port itself is
//! chain-agnostic: this crate required no changes to
//! `connector_settlement::contract::assert_upholds_the_contract`.
//!
//! Like `connector-settlement-evm`'s `EvmSettlementBackend`, this backend
//! holds no local channel state: every method reads the chain fresh before
//! deciding what the port's rules require, and only then submits a
//! transaction ("pre-flight, then submit"), keeping every
//! [`SettlementError`] variant the contract suite exercises exact and
//! reserving [`SettlementError::Backend`] for genuine I/O failure.

use std::str::FromStr;

use async_trait::async_trait;
use chrono::Duration;
use sha2::{Digest, Sha256};

use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signature, Signer};
use solana_sdk::system_program;
use solana_sdk::transaction::Transaction;

use connector_settlement::{
    ChannelId, ChannelState, ChannelStatus, Claim, SettlementBackend, SettlementError,
};
use connector_settlement_solana_program::instruction::pack;
use connector_settlement_solana_program::state::{
    Channel as ProgramChannel, ChannelStatus as ProgramChannelStatus, MAX_COUNTERPARTY_LEN,
};

/// A [`SettlementBackend`] backed by a real `connector-settlement-solana-program`
/// instance on a Solana chain.
pub struct SolanaSettlementBackend {
    rpc: RpcClient,
    program_id: Pubkey,
    payer: Keypair,
}

impl SolanaSettlementBackend {
    /// Bind to an already-deployed program at `program_id`, signing every
    /// transaction with `payer` (its fee-payer and, for [`open`](SettlementBackend::open)
    /// and [`fund`](SettlementBackend::fund), the account debited).
    ///
    /// [`open`]: SettlementBackend::open
    pub fn connect(rpc_url: &str, payer: Keypair, program_id: Pubkey) -> Self {
        Self {
            // `confirmed`, not the client default `finalized` -- a
            // single-node local validator (ADR 0007's "real chain" for
            // this tier) can take many seconds to finalize a slot, and
            // every method here already only trusts on-chain state it read
            // itself for its next decision, so waiting past `confirmed`
            // buys nothing.
            rpc: RpcClient::new_with_commitment(rpc_url.to_string(), CommitmentConfig::confirmed()),
            program_id,
            payer,
        }
    }

    /// Bind to this crate's own program at its fixed
    /// [`connector_settlement_solana_program::PROGRAM_ID`], funding a
    /// freshly generated `payer` with an airdrop. Used by this crate's own
    /// tests, and by whichever operator tooling first needs a funded
    /// backend against a disposable validator rather than an
    /// already-funded production key (see [`connect`](Self::connect) for
    /// that case).
    pub async fn deploy(rpc_url: &str) -> Result<Self, SettlementError> {
        let payer = Keypair::new();
        let program_id = Pubkey::from_str(connector_settlement_solana_program::PROGRAM_ID)
            .expect("PROGRAM_ID is a valid pubkey literal");
        let backend = Self::connect(rpc_url, payer, program_id);

        // 100 SOL: comfortably more than any contract-suite or gas/fee test
        // needs, on a local validator whose faucet has no real value.
        let signature = backend
            .rpc
            .request_airdrop(&backend.payer.pubkey(), 100_000_000_000)
            .await
            .map_err(backend_error)?;
        wait_for_confirmation(&backend.rpc, &signature).await?;

        Ok(backend)
    }

    /// The address this backend signs transactions as -- the account
    /// [`fund`](SettlementBackend::fund) debits and
    /// [`open`](SettlementBackend::open) records as a channel's `payer`.
    pub fn payer_pubkey(&self) -> Pubkey {
        self.payer.pubkey()
    }

    /// Resolve `channel` to its on-chain pubkey and current program state,
    /// or [`SettlementError::ChannelNotFound`] if `channel`'s id does not
    /// parse as a pubkey, names no account, or names one this program does
    /// not own or cannot make sense of -- any of which mean nothing this
    /// program ever opened lives there.
    async fn read_channel(
        &self,
        channel: &ChannelId,
    ) -> Result<(Pubkey, ProgramChannel), SettlementError> {
        let pubkey = Pubkey::from_str(&channel.0)
            .map_err(|_| SettlementError::ChannelNotFound(channel.clone()))?;
        let account = self
            .rpc
            .get_account_with_commitment(&pubkey, CommitmentConfig::confirmed())
            .await
            .map_err(backend_error)?
            .value
            .ok_or_else(|| SettlementError::ChannelNotFound(channel.clone()))?;
        if account.owner != self.program_id {
            return Err(SettlementError::ChannelNotFound(channel.clone()));
        }
        let state = ProgramChannel::read(&account.data)
            .map_err(|_| SettlementError::ChannelNotFound(channel.clone()))?;
        Ok((pubkey, state))
    }

    /// Resolve `channel` and reject with [`SettlementError::ChannelClosed`]
    /// if it has already been closed -- the one precondition
    /// [`fund`](SettlementBackend::fund), [`redeem`](SettlementBackend::redeem)
    /// and [`close`](SettlementBackend::close) all share before their own,
    /// method-specific checks (mirrors `EvmSettlementBackend::open_channel`).
    async fn open_channel(
        &self,
        channel: &ChannelId,
    ) -> Result<(Pubkey, ProgramChannel), SettlementError> {
        let (pubkey, state) = self.read_channel(channel).await?;
        if state.status == ProgramChannelStatus::Closed {
            return Err(SettlementError::ChannelClosed(channel.clone()));
        }
        Ok((pubkey, state))
    }

    async fn submit(
        &self,
        instruction: Instruction,
        extra_signers: &[&Keypair],
    ) -> Result<(), SettlementError> {
        let recent_blockhash = self
            .rpc
            .get_latest_blockhash()
            .await
            .map_err(backend_error)?;
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend_from_slice(extra_signers);
        let transaction = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&self.payer.pubkey()),
            &signers,
            recent_blockhash,
        );
        self.rpc
            .send_and_confirm_transaction(&transaction)
            .await
            .map_err(backend_error)?;
        Ok(())
    }
}

async fn wait_for_confirmation(
    rpc: &RpcClient,
    signature: &Signature,
) -> Result<(), SettlementError> {
    for _ in 0..200 {
        if rpc.confirm_transaction(signature).await.unwrap_or(false) {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Err(SettlementError::Backend(
        "transaction did not confirm in time".to_string(),
    ))
}

fn backend_error<E: std::fmt::Display>(error: E) -> SettlementError {
    SettlementError::Backend(error.to_string())
}

fn to_channel_state(id: &ChannelId, state: &ProgramChannel) -> ChannelState {
    ChannelState {
        id: id.clone(),
        counterparty: state.counterparty.clone(),
        status: match state.status {
            ProgramChannelStatus::Open => ChannelStatus::Open,
            ProgramChannelStatus::Closed => ChannelStatus::Closed,
        },
        deposited: from_lamports(state.deposited),
        redeemed: from_lamports(state.redeemed),
    }
}

/// The port's own contract suite deals in small dimensionless "amount"
/// units (deposits and claims of a few hundred), which EVM's wei-granular,
/// no-minimum-balance ledger accepts unchanged. Solana cannot: it enforces
/// a rent-exempt MINIMUM BALANCE on every account that isn't going to
/// exactly zero, so crediting a fresh payout account with the suite's own
/// first claim -- 60 raw lamports, a tiny fraction of a cent -- would leave
/// it under that minimum and the transaction would be rejected outright.
/// Scaling every port unit into a fixed, generous multiple of lamports
/// before it reaches the chain, and back on the way out, absorbs that
/// entirely in this backend: `connector-settlement-solana-program`'s own
/// `deposited`/`redeemed` fields are genuine lamports throughout, and the
/// port's own contract suite (which asserts on port units, not lamports)
/// needs no change.
const LAMPORTS_PER_UNIT: u64 = 10_000_000;

fn to_lamports(amount: u128) -> Result<u64, SettlementError> {
    let units = u64::try_from(amount)
        .map_err(|_| SettlementError::Backend(format!("amount {amount} does not fit in u64")))?;
    units.checked_mul(LAMPORTS_PER_UNIT).ok_or_else(|| {
        SettlementError::Backend(format!(
            "amount {amount} overflows this backend's lamport scale"
        ))
    })
}

fn from_lamports(lamports: u64) -> u128 {
    (lamports / LAMPORTS_PER_UNIT) as u128
}

/// Derive a 32-byte Solana pubkey for an arbitrary counterparty identifier
/// -- the Solana analogue of `connector-settlement-evm`'s
/// `counterparty_address`. A genuine pubkey (already 32 bytes) passes
/// through unchanged; anything else (the port's own contract suite uses
/// plain ASCII peer names, not pubkeys) is hashed down to one
/// deterministically, so the same counterparty bytes always name the same
/// payout account and `redeem`'s plain-SOL payout to it is always to a real
/// 32-byte address.
fn counterparty_pubkey(counterparty: &[u8]) -> Pubkey {
    if counterparty.len() == 32 {
        Pubkey::try_from(counterparty).expect("length checked above")
    } else {
        let hash: [u8; 32] = Sha256::digest(counterparty).into();
        Pubkey::new_from_array(hash)
    }
}

#[async_trait]
impl SettlementBackend for SolanaSettlementBackend {
    async fn open(
        &self,
        counterparty: Vec<u8>,
        settlement_timeout: Duration,
    ) -> Result<ChannelId, SettlementError> {
        if counterparty.len() > MAX_COUNTERPARTY_LEN {
            return Err(SettlementError::Backend(format!(
                "counterparty is {} bytes, this backend supports at most {MAX_COUNTERPARTY_LEN}",
                counterparty.len(),
            )));
        }
        let payout = counterparty_pubkey(&counterparty);
        let channel_keypair = Keypair::new();
        let seconds = settlement_timeout.num_seconds();

        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &pack::open(&counterparty, &payout, seconds),
            vec![
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new(channel_keypair.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
        );
        self.submit(instruction, &[&channel_keypair]).await?;
        Ok(ChannelId(channel_keypair.pubkey().to_string()))
    }

    async fn fund(
        &self,
        channel: &ChannelId,
        amount: u128,
    ) -> Result<ChannelState, SettlementError> {
        let (pubkey, _state) = self.open_channel(channel).await?;
        let amount_lamports = to_lamports(amount)?;

        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &pack::fund(amount_lamports),
            vec![
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new(pubkey, false),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
        );
        self.submit(instruction, &[]).await?;

        let (_pubkey, state) = self.read_channel(channel).await?;
        Ok(to_channel_state(channel, &state))
    }

    async fn redeem(
        &self,
        channel: &ChannelId,
        claim: Claim,
    ) -> Result<ChannelState, SettlementError> {
        let (pubkey, state) = self.open_channel(channel).await?;
        let cumulative_amount_lamports = to_lamports(claim.cumulative_amount)?;
        let already_redeemed = from_lamports(state.redeemed);
        let deposited = from_lamports(state.deposited);
        if claim.cumulative_amount <= already_redeemed {
            return Err(SettlementError::StaleClaim {
                claimed: claim.cumulative_amount,
                already_redeemed,
            });
        }
        if claim.cumulative_amount > deposited {
            return Err(SettlementError::InsufficientChannelBalance {
                requested: claim.cumulative_amount,
                deposited,
            });
        }

        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &pack::redeem(cumulative_amount_lamports, &claim.signature),
            vec![
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new(pubkey, false),
                AccountMeta::new(state.payout, false),
            ],
        );
        self.submit(instruction, &[]).await?;

        let (_pubkey, state) = self.read_channel(channel).await?;
        Ok(to_channel_state(channel, &state))
    }

    async fn close(&self, channel: &ChannelId) -> Result<ChannelState, SettlementError> {
        let (pubkey, _state) = self.open_channel(channel).await?;

        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &pack::close(),
            vec![
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new(pubkey, false),
            ],
        );
        self.submit(instruction, &[]).await?;

        let (_pubkey, state) = self.read_channel(channel).await?;
        Ok(to_channel_state(channel, &state))
    }

    async fn channel_state(&self, channel: &ChannelId) -> Result<ChannelState, SettlementError> {
        let (_pubkey, state) = self.read_channel(channel).await?;
        Ok(to_channel_state(channel, &state))
    }
}
