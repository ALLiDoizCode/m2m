//! Instruction encoding: `[opcode: u8][payload]`, unpacked by hand for the
//! same reason `state.rs` packs its account by hand -- no dependency beyond
//! `solana-program`.

use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;

use crate::state::MAX_COUNTERPARTY_LEN;

pub enum ChannelInstruction {
    /// Accounts: `[payer (signer, writable), channel (signer, writable, uninitialized), system_program]`.
    Open {
        counterparty: Vec<u8>,
        payout: Pubkey,
        settlement_timeout: i64,
    },
    /// Accounts: `[funder (signer, writable), channel (writable), system_program]`.
    Fund { amount: u64 },
    /// Accounts: `[caller (signer), channel (writable), payout (writable)]`.
    Redeem {
        cumulative_amount: u64,
        signature: Vec<u8>,
    },
    /// Accounts: `[caller (signer), channel (writable)]`.
    Close,
}

fn read_u32(data: &[u8], offset: usize) -> Result<u32, ProgramError> {
    data.get(offset..offset + 4)
        .and_then(|slice| slice.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or(ProgramError::InvalidInstructionData)
}

fn read_u64(data: &[u8], offset: usize) -> Result<u64, ProgramError> {
    data.get(offset..offset + 8)
        .and_then(|slice| slice.try_into().ok())
        .map(u64::from_le_bytes)
        .ok_or(ProgramError::InvalidInstructionData)
}

fn read_i64(data: &[u8], offset: usize) -> Result<i64, ProgramError> {
    data.get(offset..offset + 8)
        .and_then(|slice| slice.try_into().ok())
        .map(i64::from_le_bytes)
        .ok_or(ProgramError::InvalidInstructionData)
}

fn read_pubkey(data: &[u8], offset: usize) -> Result<Pubkey, ProgramError> {
    data.get(offset..offset + 32)
        .and_then(|slice| Pubkey::try_from(slice).ok())
        .ok_or(ProgramError::InvalidInstructionData)
}

impl ChannelInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        let (&opcode, rest) = data
            .split_first()
            .ok_or(ProgramError::InvalidInstructionData)?;

        match opcode {
            0 => {
                let counterparty_len = read_u32(rest, 0)? as usize;
                if counterparty_len > MAX_COUNTERPARTY_LEN {
                    return Err(ProgramError::InvalidInstructionData);
                }
                let counterparty = rest
                    .get(4..4 + counterparty_len)
                    .ok_or(ProgramError::InvalidInstructionData)?
                    .to_vec();
                let payout = read_pubkey(rest, 4 + counterparty_len)?;
                let settlement_timeout = read_i64(rest, 4 + counterparty_len + 32)?;
                Ok(Self::Open {
                    counterparty,
                    payout,
                    settlement_timeout,
                })
            }
            1 => Ok(Self::Fund {
                amount: read_u64(rest, 0)?,
            }),
            2 => {
                let cumulative_amount = read_u64(rest, 0)?;
                let signature_len = read_u32(rest, 8)? as usize;
                let signature = rest
                    .get(12..12 + signature_len)
                    .ok_or(ProgramError::InvalidInstructionData)?
                    .to_vec();
                Ok(Self::Redeem {
                    cumulative_amount,
                    signature,
                })
            }
            3 => Ok(Self::Close),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

/// The packing side of the wire format above, kept in this crate rather than
/// in `connector-settlement-solana` so the two ends of the encoding cannot
/// drift apart -- `unpack` on-chain and `pack_*` off-chain are read from the
/// same layout definition. `connector-settlement-solana` depends on this
/// crate as an ordinary library (not just for its `cdylib`) to call these.
pub mod pack {
    use solana_program::pubkey::Pubkey;

    pub fn open(counterparty: &[u8], payout: &Pubkey, settlement_timeout: i64) -> Vec<u8> {
        let mut data = Vec::with_capacity(1 + 4 + counterparty.len() + 32 + 8);
        data.push(0);
        data.extend_from_slice(&(counterparty.len() as u32).to_le_bytes());
        data.extend_from_slice(counterparty);
        data.extend_from_slice(payout.as_ref());
        data.extend_from_slice(&settlement_timeout.to_le_bytes());
        data
    }

    pub fn fund(amount: u64) -> Vec<u8> {
        let mut data = Vec::with_capacity(1 + 8);
        data.push(1);
        data.extend_from_slice(&amount.to_le_bytes());
        data
    }

    pub fn redeem(cumulative_amount: u64, signature: &[u8]) -> Vec<u8> {
        let mut data = Vec::with_capacity(1 + 8 + 4 + signature.len());
        data.push(2);
        data.extend_from_slice(&cumulative_amount.to_le_bytes());
        data.extend_from_slice(&(signature.len() as u32).to_le_bytes());
        data.extend_from_slice(signature);
        data
    }

    pub fn close() -> Vec<u8> {
        vec![3]
    }
}
