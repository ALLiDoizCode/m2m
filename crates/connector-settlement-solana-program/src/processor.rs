//! Instruction handlers -- the Solana-side twin of
//! `SettlementChannel.sol`'s four functions. Like the Solidity contract,
//! this program enforces exactly what the `SettlementBackend` port's
//! contract suite requires (monotonic redemption, bounded by what was
//! deposited, terminal once closed) and does not verify a claim's
//! signature -- that is a peer-wire concern the port itself declines to
//! specify (`connector-settlement/src/port.rs`). The signature is logged as
//! an opaque audit trail, the Solana analogue of the Solidity contract's
//! `ChannelRedeemed` event carrying it unverified.

use solana_program::account_info::{next_account_info, AccountInfo};
use solana_program::entrypoint::ProgramResult;
use solana_program::msg;
use solana_program::program::invoke;
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;
use solana_program::rent::Rent;
use solana_program::system_instruction;
use solana_program::sysvar::Sysvar;

use crate::error::ChannelError;
use crate::instruction::ChannelInstruction;
use crate::state::{Channel, ChannelStatus, ACCOUNT_SIZE};

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    match ChannelInstruction::unpack(instruction_data)? {
        ChannelInstruction::Open {
            counterparty,
            payout,
            settlement_timeout,
        } => open(
            program_id,
            accounts,
            counterparty,
            payout,
            settlement_timeout,
        ),
        ChannelInstruction::Fund { amount } => fund(accounts, amount),
        ChannelInstruction::Redeem {
            cumulative_amount,
            signature,
        } => redeem(accounts, cumulative_amount, signature),
        ChannelInstruction::Close => close(accounts),
    }
}

fn open(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    counterparty: Vec<u8>,
    payout: Pubkey,
    settlement_timeout: i64,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let payer = next_account_info(accounts_iter)?;
    let channel = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;

    if !payer.is_signer || !channel.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !channel.data_is_empty() {
        return Err(ChannelError::ChannelAlreadyInitialized.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(ACCOUNT_SIZE);
    invoke(
        &system_instruction::create_account(
            payer.key,
            channel.key,
            lamports,
            ACCOUNT_SIZE as u64,
            program_id,
        ),
        &[payer.clone(), channel.clone(), system_program.clone()],
    )?;

    let state = Channel {
        payer: *payer.key,
        counterparty,
        payout,
        settlement_timeout,
        deposited: 0,
        redeemed: 0,
        status: ChannelStatus::Open,
    };
    state.write(&mut channel.try_borrow_mut_data()?)?;
    msg!("channel opened: {}", channel.key);
    Ok(())
}

fn fund(accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let funder = next_account_info(accounts_iter)?;
    let channel = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;

    if !funder.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut state = Channel::read(&channel.try_borrow_data()?)?;
    if state.status == ChannelStatus::Closed {
        return Err(ChannelError::ChannelAlreadyClosed.into());
    }

    invoke(
        &system_instruction::transfer(funder.key, channel.key, amount),
        &[funder.clone(), channel.clone(), system_program.clone()],
    )?;

    state.deposited = state
        .deposited
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    state.write(&mut channel.try_borrow_mut_data()?)?;
    msg!("channel funded: {} amount={}", channel.key, amount);
    Ok(())
}

fn redeem(accounts: &[AccountInfo], cumulative_amount: u64, signature: Vec<u8>) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let caller = next_account_info(accounts_iter)?;
    let channel = next_account_info(accounts_iter)?;
    let payout = next_account_info(accounts_iter)?;

    if !caller.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut state = Channel::read(&channel.try_borrow_data()?)?;
    if state.status == ChannelStatus::Closed {
        return Err(ChannelError::ChannelAlreadyClosed.into());
    }
    if cumulative_amount <= state.redeemed {
        return Err(ChannelError::StaleClaim.into());
    }
    if cumulative_amount > state.deposited {
        return Err(ChannelError::InsufficientChannelBalance.into());
    }
    if payout.key != &state.payout {
        return Err(ChannelError::WrongPayoutAccount.into());
    }

    let delta = cumulative_amount - state.redeemed;
    **channel.try_borrow_mut_lamports()? = channel
        .lamports()
        .checked_sub(delta)
        .ok_or(ProgramError::InsufficientFunds)?;
    **payout.try_borrow_mut_lamports()? = payout
        .lamports()
        .checked_add(delta)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    state.redeemed = cumulative_amount;
    state.write(&mut channel.try_borrow_mut_data()?)?;
    msg!(
        "channel redeemed: {} cumulative_amount={} signature={:?}",
        channel.key,
        cumulative_amount,
        signature
    );
    Ok(())
}

fn close(accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let caller = next_account_info(accounts_iter)?;
    let channel = next_account_info(accounts_iter)?;

    if !caller.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut state = Channel::read(&channel.try_borrow_data()?)?;
    if state.status == ChannelStatus::Closed {
        return Err(ChannelError::ChannelAlreadyClosed.into());
    }

    state.status = ChannelStatus::Closed;
    state.write(&mut channel.try_borrow_mut_data()?)?;
    msg!("channel closed: {}", channel.key);
    Ok(())
}
