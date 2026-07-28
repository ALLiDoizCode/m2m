//! Instruction handlers -- the Solana-side twin of
//! `SettlementChannel.sol`'s five functions. Like the Solidity contract,
//! this program enforces exactly what the `SettlementBackend` port's
//! contract suite requires (monotonic redemption, bounded by what was
//! deposited, redeemable through a closed channel's challenge period and
//! terminal only once settled -- issue #574) and does not verify a claim's
//! signature -- that is a peer-wire concern the port itself declines to
//! specify (`connector-settlement/src/port.rs`). The signature is logged as
//! an opaque audit trail, the Solana analogue of the Solidity contract's
//! `ChannelRedeemed` event carrying it unverified.

use solana_program::account_info::{next_account_info, AccountInfo};
use solana_program::clock::Clock;
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
        ChannelInstruction::Settle => settle(accounts),
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
        closed_at: 0,
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
    if state.status != ChannelStatus::Open {
        return Err(channel_not_open_error(&state));
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
    if state.status == ChannelStatus::Settled {
        return Err(ChannelError::ChannelAlreadySettled.into());
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
    if state.status != ChannelStatus::Open {
        return Err(channel_not_open_error(&state));
    }

    state.status = ChannelStatus::Closed;
    state.closed_at = Clock::get()?.unix_timestamp;
    state.write(&mut channel.try_borrow_mut_data()?)?;
    msg!("channel closed: {}", channel.key);
    Ok(())
}

/// Settle a channel once its challenge period -- `closed_at +
/// settlement_timeout` -- has elapsed: pays out its remaining, unredeemed
/// deposit to `payer` and marks it permanently done. Fails with
/// `SettlementNotYetDue` if called too early (including against a channel
/// that was never closed at all -- its deadline is unreachable).
/// Deliberately permissionless (issue #574, matching
/// `TokenNetwork.settleChannel`): no signer-identity check beyond "some
/// transaction fee payer signed this", so a counterparty cannot strand a
/// channel's deposit by refusing to ever settle it.
fn settle(accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let caller = next_account_info(accounts_iter)?;
    let channel = next_account_info(accounts_iter)?;
    let payer_account = next_account_info(accounts_iter)?;

    if !caller.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut state = Channel::read(&channel.try_borrow_data()?)?;
    if state.status == ChannelStatus::Settled {
        return Err(ChannelError::ChannelAlreadySettled.into());
    }
    let available_at = if state.status == ChannelStatus::Closed {
        state.closed_at.saturating_add(state.settlement_timeout)
    } else {
        i64::MAX
    };
    let now = Clock::get()?.unix_timestamp;
    if now < available_at {
        return Err(ChannelError::SettlementNotYetDue.into());
    }
    if payer_account.key != &state.payer {
        return Err(ChannelError::WrongPayoutAccount.into());
    }

    let refund = state.deposited.saturating_sub(state.redeemed);
    if refund > 0 {
        **channel.try_borrow_mut_lamports()? = channel
            .lamports()
            .checked_sub(refund)
            .ok_or(ProgramError::InsufficientFunds)?;
        **payer_account.try_borrow_mut_lamports()? = payer_account
            .lamports()
            .checked_add(refund)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    }

    state.status = ChannelStatus::Settled;
    state.write(&mut channel.try_borrow_mut_data()?)?;
    msg!("channel settled: {} refund={}", channel.key, refund);
    Ok(())
}

/// `fund` and `close` both require `Open`; distinguish `Closed` from
/// `Settled` in the error reported rather than collapsing both into
/// `ChannelAlreadyClosed` (issue #574 -- mirrors `SettlementChannel.sol`'s
/// `_open`).
fn channel_not_open_error(state: &Channel) -> ProgramError {
    if state.status == ChannelStatus::Settled {
        ChannelError::ChannelAlreadySettled.into()
    } else {
        ChannelError::ChannelAlreadyClosed.into()
    }
}
