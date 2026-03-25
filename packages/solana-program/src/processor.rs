// Payment Channel Program — Instruction Processor
//
// Handles all channel lifecycle instructions: initialize, deposit, close, settle, force_close.

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::{self, Sysvar},
};

use crate::error::PaymentChannelError;
use crate::instruction::PaymentChannelInstruction;
use crate::state::{ChannelState, ChannelStatus, ACCOUNT_SIZE};

/// Main instruction dispatcher.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = PaymentChannelInstruction::unpack(instruction_data)?;

    match instruction {
        PaymentChannelInstruction::InitializeChannel { challenge_duration } => {
            process_initialize_channel(program_id, accounts, challenge_duration)
        }
        PaymentChannelInstruction::Deposit { amount } => {
            process_deposit(program_id, accounts, amount)
        }
        PaymentChannelInstruction::CloseChannel => process_close_channel(program_id, accounts),
        PaymentChannelInstruction::SettleChannel => process_settle_channel(program_id, accounts),
        PaymentChannelInstruction::ForceCloseExpired => {
            process_force_close_expired(program_id, accounts)
        }
        PaymentChannelInstruction::ClaimFromChannel => {
            // Story 33.2 — not yet implemented
            msg!("claim_from_channel not yet implemented (Story 33.2)");
            Err(ProgramError::InvalidInstructionData)
        }
    }
}

/// Sort participants lexicographically, returning (min, max).
fn sort_participants(a: &Pubkey, b: &Pubkey) -> (Pubkey, Pubkey) {
    if a < b {
        (*a, *b)
    } else {
        (*b, *a)
    }
}

/// Derive channel PDA with sorted participants.
fn derive_channel_pda(
    participant_a: &Pubkey,
    participant_b: &Pubkey,
    token_mint: &Pubkey,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    let (min, max) = sort_participants(participant_a, participant_b);
    Pubkey::find_program_address(
        &[b"channel", min.as_ref(), max.as_ref(), token_mint.as_ref()],
        program_id,
    )
}

/// Derive vault PDA from channel PDA.
fn derive_vault_pda(channel_pda: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"vault", channel_pda.as_ref()], program_id)
}

// ---------------------------------------------------------------------------
// initialize_channel
// ---------------------------------------------------------------------------
// Accounts:
//   0. [signer, writable] payer
//   1. [] participant_a
//   2. [] participant_b
//   3. [] token_mint
//   4. [writable] channel_pda
//   5. [writable] vault_pda
//   6. [] system_program
//   7. [] token_program
//   8. [] rent sysvar

fn process_initialize_channel(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    challenge_duration: u64,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let payer = next_account_info(account_iter)?;
    let participant_a_info = next_account_info(account_iter)?;
    let participant_b_info = next_account_info(account_iter)?;
    let token_mint_info = next_account_info(account_iter)?;
    let channel_pda_info = next_account_info(account_iter)?;
    let vault_pda_info = next_account_info(account_iter)?;
    let system_program = next_account_info(account_iter)?;
    let token_program = next_account_info(account_iter)?;
    let rent_sysvar = next_account_info(account_iter)?;

    // Payer must be a signer
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate system program identity
    if *system_program.key != solana_program::system_program::id() {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Validate token program identity
    if *token_program.key != spl_token::id() {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Validate rent sysvar identity
    if *rent_sysvar.key != sysvar::rent::id() {
        return Err(ProgramError::InvalidArgument);
    }

    // Reject self-channel: participants must be different
    if participant_a_info.key == participant_b_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    // Derive and verify channel PDA
    let (expected_channel_pda, channel_bump) = derive_channel_pda(
        participant_a_info.key,
        participant_b_info.key,
        token_mint_info.key,
        program_id,
    );
    if *channel_pda_info.key != expected_channel_pda {
        return Err(PaymentChannelError::InvalidPDA.into());
    }

    // Reject double-init: if the account already has data, it exists
    if !channel_pda_info.data_is_empty() {
        return Err(PaymentChannelError::ChannelAlreadyExists.into());
    }

    // Derive and verify vault PDA
    let (expected_vault_pda, vault_bump) = derive_vault_pda(&expected_channel_pda, program_id);
    if *vault_pda_info.key != expected_vault_pda {
        return Err(PaymentChannelError::InvalidVaultPDA.into());
    }

    // Sort participants lexicographically
    let (min_participant, max_participant) =
        sort_participants(participant_a_info.key, participant_b_info.key);

    // Create channel PDA account
    let rent = Rent::get()?;
    let channel_rent = rent.minimum_balance(ACCOUNT_SIZE);
    let channel_seeds: &[&[u8]] = &[
        b"channel",
        min_participant.as_ref(),
        max_participant.as_ref(),
        token_mint_info.key.as_ref(),
        &[channel_bump],
    ];

    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            channel_pda_info.key,
            channel_rent,
            ACCOUNT_SIZE as u64,
            program_id,
        ),
        &[payer.clone(), channel_pda_info.clone(), system_program.clone()],
        &[channel_seeds],
    )?;

    // Create vault token account (raw SPL Token account owned by vault PDA)
    let vault_seeds: &[&[u8]] = &[
        b"vault",
        expected_channel_pda.as_ref(),
        &[vault_bump],
    ];
    let token_account_size = spl_token::state::Account::LEN;
    let vault_rent = rent.minimum_balance(token_account_size);

    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            vault_pda_info.key,
            vault_rent,
            token_account_size as u64,
            &spl_token::id(),
        ),
        &[payer.clone(), vault_pda_info.clone(), system_program.clone()],
        &[vault_seeds],
    )?;

    // Initialize the vault as an SPL Token account owned by the vault PDA itself
    invoke(
        &spl_token::instruction::initialize_account(
            &spl_token::id(),
            vault_pda_info.key,
            token_mint_info.key,
            vault_pda_info.key, // vault owns itself (PDA authority)
        )?,
        &[
            vault_pda_info.clone(),
            token_mint_info.clone(),
            vault_pda_info.clone(),
            rent_sysvar.clone(),
        ],
    )?;

    // Initialize channel state
    let channel_state = ChannelState {
        participant_a: min_participant,
        participant_b: max_participant,
        token_mint: *token_mint_info.key,
        deposit_a: 0,
        deposit_b: 0,
        transferred_amount_a: 0,
        transferred_amount_b: 0,
        nonce_a: 0,
        nonce_b: 0,
        state: ChannelStatus::Opened as u8,
        close_timestamp: 0,
        challenge_duration,
        bump: channel_bump,
    };

    let mut data = channel_pda_info.try_borrow_mut_data()?;
    channel_state.serialize(&mut data)?;

    msg!("Payment channel initialized");
    Ok(())
}

// ---------------------------------------------------------------------------
// deposit
// ---------------------------------------------------------------------------
// Accounts:
//   0. [signer] depositor
//   1. [writable] depositor_token_account
//   2. [writable] vault_token_account
//   3. [writable] channel_pda
//   4. [] token_program

fn process_deposit(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    amount: u64,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let depositor = next_account_info(account_iter)?;
    let depositor_token_account = next_account_info(account_iter)?;
    let vault_token_account = next_account_info(account_iter)?;
    let channel_pda_info = next_account_info(account_iter)?;
    let token_program = next_account_info(account_iter)?;

    if !depositor.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate token program identity
    if *token_program.key != spl_token::id() {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Reject zero-amount deposits
    if amount == 0 {
        return Err(PaymentChannelError::ZeroAmountDeposit.into());
    }

    // Verify channel is owned by this program
    if channel_pda_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Verify vault PDA matches the expected derivation from channel PDA
    let (expected_vault, _) = derive_vault_pda(channel_pda_info.key, program_id);
    if *vault_token_account.key != expected_vault {
        return Err(PaymentChannelError::InvalidVaultPDA.into());
    }

    // Deserialize channel state
    let data = channel_pda_info.try_borrow_data()?;
    let mut channel = ChannelState::deserialize(&data)?;
    drop(data);

    // Verify channel PDA derivation matches stored participants and mint
    let (expected_channel_pda, _) = derive_channel_pda(
        &channel.participant_a,
        &channel.participant_b,
        &channel.token_mint,
        program_id,
    );
    if *channel_pda_info.key != expected_channel_pda {
        return Err(PaymentChannelError::InvalidPDA.into());
    }

    // Verify channel is Opened
    if channel.state != ChannelStatus::Opened as u8 {
        return Err(PaymentChannelError::ChannelNotOpened.into());
    }

    // Determine which participant is depositing
    let is_participant_a = *depositor.key == channel.participant_a;
    let is_participant_b = *depositor.key == channel.participant_b;
    if !is_participant_a && !is_participant_b {
        return Err(PaymentChannelError::InvalidParticipant.into());
    }

    // Transfer tokens from depositor to vault
    invoke(
        &spl_token::instruction::transfer(
            &spl_token::id(),
            depositor_token_account.key,
            vault_token_account.key,
            depositor.key,
            &[],
            amount,
        )?,
        &[
            depositor_token_account.clone(),
            vault_token_account.clone(),
            depositor.clone(),
            token_program.clone(),
        ],
    )?;

    // Update deposit tracker
    if is_participant_a {
        channel.deposit_a = channel
            .deposit_a
            .checked_add(amount)
            .ok_or(PaymentChannelError::ArithmeticOverflow)?;
    } else {
        channel.deposit_b = channel
            .deposit_b
            .checked_add(amount)
            .ok_or(PaymentChannelError::ArithmeticOverflow)?;
    }

    // Write back
    let mut data = channel_pda_info.try_borrow_mut_data()?;
    channel.serialize(&mut data)?;

    msg!("Deposit of {} tokens recorded", amount);
    Ok(())
}

// ---------------------------------------------------------------------------
// close_channel
// ---------------------------------------------------------------------------
// Accounts:
//   0. [signer] closer
//   1. [writable] channel_pda
//   2. [] clock sysvar

fn process_close_channel(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let closer = next_account_info(account_iter)?;
    let channel_pda_info = next_account_info(account_iter)?;
    let _clock_sysvar = next_account_info(account_iter)?;

    if !closer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if channel_pda_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    let data = channel_pda_info.try_borrow_data()?;
    let mut channel = ChannelState::deserialize(&data)?;
    drop(data);

    // Verify channel PDA derivation matches stored participants and mint
    let (expected_channel_pda, _) = derive_channel_pda(
        &channel.participant_a,
        &channel.participant_b,
        &channel.token_mint,
        program_id,
    );
    if *channel_pda_info.key != expected_channel_pda {
        return Err(PaymentChannelError::InvalidPDA.into());
    }

    // Verify channel is Opened
    if channel.state != ChannelStatus::Opened as u8 {
        return Err(PaymentChannelError::ChannelNotOpened.into());
    }

    // Verify closer is a participant
    if *closer.key != channel.participant_a && *closer.key != channel.participant_b {
        return Err(PaymentChannelError::InvalidParticipant.into());
    }

    // Set state to Closed and record timestamp
    let clock = Clock::get()?;
    channel.state = ChannelStatus::Closed as u8;
    channel.close_timestamp = clock.unix_timestamp;

    let mut data = channel_pda_info.try_borrow_mut_data()?;
    channel.serialize(&mut data)?;

    msg!("Channel closed at timestamp {}", clock.unix_timestamp);
    Ok(())
}

// ---------------------------------------------------------------------------
// settle_channel / force_close_expired (shared logic)
// ---------------------------------------------------------------------------
// Accounts:
//   0. [signer] caller
//   1. [writable] channel_pda
//   2. [writable] vault_token_account
//   3. [writable] participant_a_token_account
//   4. [writable] participant_b_token_account
//   5. [writable] rent_recipient
//   6. [] token_program
//   7. [] clock sysvar

fn process_settlement(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let caller = next_account_info(account_iter)?;
    let channel_pda_info = next_account_info(account_iter)?;
    let vault_token_account = next_account_info(account_iter)?;
    let participant_a_token = next_account_info(account_iter)?;
    let participant_b_token = next_account_info(account_iter)?;
    let rent_recipient = next_account_info(account_iter)?;
    let token_program = next_account_info(account_iter)?;
    let _clock_sysvar = next_account_info(account_iter)?;

    if !caller.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate token program identity
    if *token_program.key != spl_token::id() {
        return Err(ProgramError::IncorrectProgramId);
    }

    if channel_pda_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    let data = channel_pda_info.try_borrow_data()?;
    let channel = ChannelState::deserialize(&data)?;
    drop(data);

    // Verify channel PDA derivation matches stored participants and mint
    let (expected_channel_pda, _) = derive_channel_pda(
        &channel.participant_a,
        &channel.participant_b,
        &channel.token_mint,
        program_id,
    );
    if *channel_pda_info.key != expected_channel_pda {
        return Err(PaymentChannelError::InvalidPDA.into());
    }

    // Verify channel is Closed
    if channel.state != ChannelStatus::Closed as u8 {
        return Err(PaymentChannelError::ChannelNotClosed.into());
    }

    // Verify challenge period has elapsed
    let clock = Clock::get()?;
    let challenge_duration_i64 = i64::try_from(channel.challenge_duration)
        .map_err(|_| PaymentChannelError::ArithmeticOverflow)?;
    let deadline = channel
        .close_timestamp
        .checked_add(challenge_duration_i64)
        .ok_or(PaymentChannelError::ArithmeticOverflow)?;
    if clock.unix_timestamp < deadline {
        return Err(PaymentChannelError::ChannelChallengeNotExpired.into());
    }

    // Calculate final balances:
    //   A gets: deposit_a - transferred_amount_a + transferred_amount_b
    //   B gets: deposit_b - transferred_amount_b + transferred_amount_a
    let balance_a = channel
        .deposit_a
        .checked_sub(channel.transferred_amount_a)
        .and_then(|v| v.checked_add(channel.transferred_amount_b))
        .ok_or(PaymentChannelError::ArithmeticOverflow)?;

    let balance_b = channel
        .deposit_b
        .checked_sub(channel.transferred_amount_b)
        .and_then(|v| v.checked_add(channel.transferred_amount_a))
        .ok_or(PaymentChannelError::ArithmeticOverflow)?;

    // Derive vault PDA seeds for signing
    let channel_pda_key = *channel_pda_info.key;
    let (expected_vault, vault_bump) = derive_vault_pda(&channel_pda_key, program_id);
    if *vault_token_account.key != expected_vault {
        return Err(PaymentChannelError::InvalidVaultPDA.into());
    }

    let vault_seeds: &[&[u8]] = &[
        b"vault",
        channel_pda_key.as_ref(),
        &[vault_bump],
    ];

    // Transfer balance_a to participant A's token account
    if balance_a > 0 {
        invoke_signed(
            &spl_token::instruction::transfer(
                &spl_token::id(),
                vault_token_account.key,
                participant_a_token.key,
                vault_token_account.key, // vault is its own authority
                &[],
                balance_a,
            )?,
            &[
                vault_token_account.clone(),
                participant_a_token.clone(),
                vault_token_account.clone(),
                token_program.clone(),
            ],
            &[vault_seeds],
        )?;
    }

    // Transfer balance_b to participant B's token account
    if balance_b > 0 {
        invoke_signed(
            &spl_token::instruction::transfer(
                &spl_token::id(),
                vault_token_account.key,
                participant_b_token.key,
                vault_token_account.key,
                &[],
                balance_b,
            )?,
            &[
                vault_token_account.clone(),
                participant_b_token.clone(),
                vault_token_account.clone(),
                token_program.clone(),
            ],
            &[vault_seeds],
        )?;
    }

    // Close vault token account (transfer remaining lamports to rent recipient)
    invoke_signed(
        &spl_token::instruction::close_account(
            &spl_token::id(),
            vault_token_account.key,
            rent_recipient.key,
            vault_token_account.key, // vault is its own authority
            &[],
        )?,
        &[
            vault_token_account.clone(),
            rent_recipient.clone(),
            vault_token_account.clone(),
            token_program.clone(),
        ],
        &[vault_seeds],
    )?;

    // Close channel PDA account — transfer lamports to rent recipient
    let channel_lamports = channel_pda_info.lamports();
    **channel_pda_info.try_borrow_mut_lamports()? = 0;
    **rent_recipient.try_borrow_mut_lamports()? = rent_recipient
        .lamports()
        .checked_add(channel_lamports)
        .ok_or(PaymentChannelError::ArithmeticOverflow)?;

    // Zero out channel data to mark as closed
    let mut data = channel_pda_info.try_borrow_mut_data()?;
    for byte in data.iter_mut() {
        *byte = 0;
    }

    msg!("Channel settled: A={}, B={}", balance_a, balance_b);
    Ok(())
}

fn process_settle_channel(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    process_settlement(program_id, accounts)
}

fn process_force_close_expired(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    process_settlement(program_id, accounts)
}
