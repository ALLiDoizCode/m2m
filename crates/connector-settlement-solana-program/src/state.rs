//! `Channel` account layout: a fixed-size, manually packed byte layout (no
//! borsh, no serde) -- the same style `packages/solana-program` (the legacy
//! program this workspace already builds) uses, chosen here for the same
//! reason: it keeps this crate's only dependency `solana-program` itself.

use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;

/// 8-byte discriminator identifying an initialized `Channel` account, so a
/// stale or foreign account can be told apart from a real one instead of
/// being misread as zeroed state.
pub const DISCRIMINATOR: [u8; 8] = *b"schannel";

/// The longest `counterparty` this program stores. The port's own contract
/// suite uses short ASCII peer names (`counterparty-a`, `gas-estimation-peer`,
/// ...); 64 bytes comfortably covers those and a raw 32-byte pubkey alike.
pub const MAX_COUNTERPARTY_LEN: usize = 64;

const DISCRIMINATOR_OFFSET: usize = 0;
const PAYER_OFFSET: usize = 8;
const COUNTERPARTY_LEN_OFFSET: usize = 40;
const COUNTERPARTY_OFFSET: usize = 44;
const PAYOUT_OFFSET: usize = COUNTERPARTY_OFFSET + MAX_COUNTERPARTY_LEN; // 108
const SETTLEMENT_TIMEOUT_OFFSET: usize = PAYOUT_OFFSET + 32; // 140
const DEPOSITED_OFFSET: usize = SETTLEMENT_TIMEOUT_OFFSET + 8; // 148
const REDEEMED_OFFSET: usize = DEPOSITED_OFFSET + 8; // 156
const CLOSED_AT_OFFSET: usize = REDEEMED_OFFSET + 8; // 164
const STATUS_OFFSET: usize = CLOSED_AT_OFFSET + 8; // 172

/// Total size of a `Channel` account's data, discriminator included. 3 bytes
/// past `STATUS_OFFSET` are reserved padding.
pub const ACCOUNT_SIZE: usize = STATUS_OFFSET + 4;

/// `Closed` and `Settled` are deliberately distinct (issue #574): `Close`
/// starts a challenge period (`settlement_timeout`) during which `Redeem`
/// still works -- refusing to redeem in that window would hand the whole
/// outstanding balance back to whichever party closed the channel. Only
/// `Settled`, reached once that timeout has elapsed and `Settle` has run,
/// is terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ChannelStatus {
    Open = 0,
    /// Closed: its challenge period is running (or, once the timeout has
    /// elapsed, is simply unclaimed). `Fund` and a second `Close` are
    /// refused, but `Redeem` still succeeds.
    Closed = 1,
    /// Settled: `Settle` has run to completion. Terminal -- no further
    /// `Fund` or `Redeem` is possible.
    Settled = 2,
}

/// A channel's on-chain state -- the Solana-side twin of
/// `connector-settlement-evm`'s `SettlementChannel.Channel` struct, laid out
/// as the same fields for the same reason (ADR 0004: no `lockedAmount`/
/// `locksRoot`).
pub struct Channel {
    pub payer: Pubkey,
    pub counterparty: Vec<u8>,
    pub payout: Pubkey,
    pub settlement_timeout: i64,
    pub deposited: u64,
    pub redeemed: u64,
    /// Unix timestamp `Close` ran, if it has (`0` otherwise). `Settle`
    /// measures its own timeout from here (issue #574).
    pub closed_at: i64,
    pub status: ChannelStatus,
}

impl Channel {
    pub fn read(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < ACCOUNT_SIZE || data[DISCRIMINATOR_OFFSET..PAYER_OFFSET] != DISCRIMINATOR {
            return Err(ProgramError::UninitializedAccount);
        }

        let counterparty_len = u32::from_le_bytes(
            data[COUNTERPARTY_LEN_OFFSET..COUNTERPARTY_LEN_OFFSET + 4]
                .try_into()
                .map_err(|_| ProgramError::InvalidAccountData)?,
        ) as usize;
        if counterparty_len > MAX_COUNTERPARTY_LEN {
            return Err(ProgramError::InvalidAccountData);
        }

        let status = match data[STATUS_OFFSET] {
            0 => ChannelStatus::Open,
            1 => ChannelStatus::Closed,
            2 => ChannelStatus::Settled,
            _ => return Err(ProgramError::InvalidAccountData),
        };

        Ok(Self {
            payer: Pubkey::try_from(&data[PAYER_OFFSET..PAYER_OFFSET + 32])
                .map_err(|_| ProgramError::InvalidAccountData)?,
            counterparty: data[COUNTERPARTY_OFFSET..COUNTERPARTY_OFFSET + counterparty_len]
                .to_vec(),
            payout: Pubkey::try_from(&data[PAYOUT_OFFSET..PAYOUT_OFFSET + 32])
                .map_err(|_| ProgramError::InvalidAccountData)?,
            settlement_timeout: i64::from_le_bytes(
                data[SETTLEMENT_TIMEOUT_OFFSET..SETTLEMENT_TIMEOUT_OFFSET + 8]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidAccountData)?,
            ),
            deposited: u64::from_le_bytes(
                data[DEPOSITED_OFFSET..DEPOSITED_OFFSET + 8]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidAccountData)?,
            ),
            redeemed: u64::from_le_bytes(
                data[REDEEMED_OFFSET..REDEEMED_OFFSET + 8]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidAccountData)?,
            ),
            closed_at: i64::from_le_bytes(
                data[CLOSED_AT_OFFSET..CLOSED_AT_OFFSET + 8]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidAccountData)?,
            ),
            status,
        })
    }

    pub fn write(&self, data: &mut [u8]) -> Result<(), ProgramError> {
        if data.len() < ACCOUNT_SIZE {
            return Err(ProgramError::AccountDataTooSmall);
        }
        if self.counterparty.len() > MAX_COUNTERPARTY_LEN {
            return Err(ProgramError::InvalidInstructionData);
        }

        data[DISCRIMINATOR_OFFSET..PAYER_OFFSET].copy_from_slice(&DISCRIMINATOR);
        data[PAYER_OFFSET..PAYER_OFFSET + 32].copy_from_slice(self.payer.as_ref());
        data[COUNTERPARTY_LEN_OFFSET..COUNTERPARTY_LEN_OFFSET + 4]
            .copy_from_slice(&(self.counterparty.len() as u32).to_le_bytes());
        data[COUNTERPARTY_OFFSET..COUNTERPARTY_OFFSET + MAX_COUNTERPARTY_LEN].fill(0);
        data[COUNTERPARTY_OFFSET..COUNTERPARTY_OFFSET + self.counterparty.len()]
            .copy_from_slice(&self.counterparty);
        data[PAYOUT_OFFSET..PAYOUT_OFFSET + 32].copy_from_slice(self.payout.as_ref());
        data[SETTLEMENT_TIMEOUT_OFFSET..SETTLEMENT_TIMEOUT_OFFSET + 8]
            .copy_from_slice(&self.settlement_timeout.to_le_bytes());
        data[DEPOSITED_OFFSET..DEPOSITED_OFFSET + 8].copy_from_slice(&self.deposited.to_le_bytes());
        data[REDEEMED_OFFSET..REDEEMED_OFFSET + 8].copy_from_slice(&self.redeemed.to_le_bytes());
        data[CLOSED_AT_OFFSET..CLOSED_AT_OFFSET + 8].copy_from_slice(&self.closed_at.to_le_bytes());
        data[STATUS_OFFSET] = self.status as u8;
        data[STATUS_OFFSET + 1..ACCOUNT_SIZE].fill(0);
        Ok(())
    }
}
