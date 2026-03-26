// Payment Channel Program — Instruction Processor
//
// Handles all channel instructions: initialize, deposit, close, settle, force_close,
// and claim_from_channel (Ed25519 precompile introspection for balance proof verification).

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
    sysvar::{self, instructions as sysvar_instructions, Sysvar},
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
        PaymentChannelInstruction::ClaimFromChannel {
            nonce,
            transferred_amount,
        } => process_claim_from_channel(program_id, accounts, nonce, transferred_amount),
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
        &[
            payer.clone(),
            channel_pda_info.clone(),
            system_program.clone(),
        ],
        &[channel_seeds],
    )?;

    // Create vault token account (raw SPL Token account owned by vault PDA)
    let vault_seeds: &[&[u8]] = &[b"vault", expected_channel_pda.as_ref(), &[vault_bump]];
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
        &[
            payer.clone(),
            vault_pda_info.clone(),
            system_program.clone(),
        ],
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

fn process_deposit(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
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

fn process_close_channel(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
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

fn process_settlement(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
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

    let vault_seeds: &[&[u8]] = &[b"vault", channel_pda_key.as_ref(), &[vault_bump]];

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

fn process_settle_channel(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    process_settlement(program_id, accounts)
}

fn process_force_close_expired(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    process_settlement(program_id, accounts)
}

// ---------------------------------------------------------------------------
// claim_from_channel
// ---------------------------------------------------------------------------
// Accounts:
//   0. [signer]    claimer        — participant submitting the claim
//   1. [writable]  channel_pda    — channel state account
//   2. []          instructions   — Instructions sysvar

/// Ed25519 precompile instruction data offsets (matching solana-sdk layout).
const ED25519_PUBKEY_SERIALIZED_SIZE: usize = 32;
const ED25519_SIGNATURE_OFFSETS_SERIALIZED_SIZE: usize = 14;
const ED25519_SIGNATURE_OFFSETS_START: usize = 2;
const ED25519_DATA_START: usize =
    ED25519_SIGNATURE_OFFSETS_SERIALIZED_SIZE + ED25519_SIGNATURE_OFFSETS_START;

fn process_claim_from_channel(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    nonce: u64,
    transferred_amount: u64,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let claimer = next_account_info(account_iter)?;
    let channel_pda_info = next_account_info(account_iter)?;
    let instructions_sysvar = next_account_info(account_iter)?;

    // Claimer must be a signer
    if !claimer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Verify instructions sysvar identity
    if !sysvar_instructions::check_id(instructions_sysvar.key) {
        return Err(ProgramError::InvalidArgument);
    }

    // Verify channel is owned by this program
    if channel_pda_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Deserialize channel state
    let data = channel_pda_info.try_borrow_data()?;
    let mut channel = ChannelState::deserialize(&data)?;
    drop(data);

    // Verify channel PDA derivation
    let (expected_channel_pda, _) = derive_channel_pda(
        &channel.participant_a,
        &channel.participant_b,
        &channel.token_mint,
        program_id,
    );
    if *channel_pda_info.key != expected_channel_pda {
        return Err(PaymentChannelError::InvalidPDA.into());
    }

    // Reject if channel state is Settled (allow Opened and Closed).
    // Note: Reuses ChannelNotOpened error for Settled state to avoid adding new error codes
    // (error code stability required by Stories 33.4/33.5). In practice, settled channels have
    // zeroed account data and would fail deserialization before reaching this check.
    let status = ChannelStatus::from_u8(channel.state);
    match status {
        Some(ChannelStatus::Opened) | Some(ChannelStatus::Closed) => {}
        Some(ChannelStatus::Settled) | None => {
            return Err(PaymentChannelError::ChannelNotOpened.into());
        }
    }

    // Determine which participant the claimer is
    let is_participant_a = *claimer.key == channel.participant_a;
    let is_participant_b = *claimer.key == channel.participant_b;
    if !is_participant_a && !is_participant_b {
        return Err(PaymentChannelError::UnauthorizedSigner.into());
    }

    // Verify nonce is strictly greater than stored nonce
    let stored_nonce = if is_participant_a {
        channel.nonce_a
    } else {
        channel.nonce_b
    };
    if nonce <= stored_nonce {
        return Err(PaymentChannelError::NonceNotMonotonic.into());
    }

    // Verify transferred_amount >= stored transferred_amount
    let stored_transferred = if is_participant_a {
        channel.transferred_amount_a
    } else {
        channel.transferred_amount_b
    };
    if transferred_amount < stored_transferred {
        return Err(PaymentChannelError::TransferredAmountDecreased.into());
    }

    // Verify Ed25519 precompile instruction at index 0
    verify_ed25519_precompile(
        instructions_sysvar,
        claimer.key,
        channel_pda_info.key,
        nonce,
        transferred_amount,
    )?;

    // Update channel state for the claiming participant
    if is_participant_a {
        channel.nonce_a = nonce;
        channel.transferred_amount_a = transferred_amount;
    } else {
        channel.nonce_b = nonce;
        channel.transferred_amount_b = transferred_amount;
    }

    // Serialize updated state back
    let mut data = channel_pda_info.try_borrow_mut_data()?;
    channel.serialize(&mut data)?;

    msg!(
        "Claim processed: nonce={}, transferred_amount={}",
        nonce,
        transferred_amount
    );
    Ok(())
}

/// Verify that the Ed25519 precompile instruction at index 0 contains a valid
/// signature verification for the expected balance proof message.
fn verify_ed25519_precompile(
    instructions_sysvar: &AccountInfo,
    claimer: &Pubkey,
    channel_pda: &Pubkey,
    nonce: u64,
    transferred_amount: u64,
) -> ProgramResult {
    // Load instruction at index 0 (Ed25519 precompile must be first)
    let ed25519_ix = sysvar_instructions::load_instruction_at_checked(0, instructions_sysvar)
        .map_err(|_| PaymentChannelError::InvalidSignature)?;

    // Verify it's the Ed25519 precompile program
    if ed25519_ix.program_id != solana_program::ed25519_program::id() {
        return Err(PaymentChannelError::InvalidSignature.into());
    }

    let ix_data = &ed25519_ix.data;

    // Minimum size check: header (2 bytes) + offsets (14 bytes) = 16 bytes
    if ix_data.len() < ED25519_DATA_START {
        return Err(PaymentChannelError::InvalidSignature.into());
    }

    // Check num_signatures == 1
    if ix_data[0] != 1 {
        return Err(PaymentChannelError::InvalidSignature.into());
    }

    // Parse offsets from the Ed25519 instruction data
    let signature_ix_index = u16::from_le_bytes([ix_data[4], ix_data[5]]);
    let public_key_offset = u16::from_le_bytes([ix_data[6], ix_data[7]]) as usize;
    let public_key_ix_index = u16::from_le_bytes([ix_data[8], ix_data[9]]);
    let message_data_offset = u16::from_le_bytes([ix_data[10], ix_data[11]]) as usize;
    let message_data_size = u16::from_le_bytes([ix_data[12], ix_data[13]]) as usize;
    let message_ix_index = u16::from_le_bytes([ix_data[14], ix_data[15]]);

    // Defense-in-depth: all data (signature, public key, message) must reside within
    // the Ed25519 instruction itself (index = 0xFFFF). Reject instructions that reference
    // data from other transaction instructions to prevent cross-instruction data confusion.
    if signature_ix_index != u16::MAX
        || public_key_ix_index != u16::MAX
        || message_ix_index != u16::MAX
    {
        return Err(PaymentChannelError::InvalidSignature.into());
    }

    // Extract public key from the instruction data
    let pubkey_end = public_key_offset
        .checked_add(ED25519_PUBKEY_SERIALIZED_SIZE)
        .ok_or::<ProgramError>(PaymentChannelError::InvalidSignature.into())?;
    if ix_data.len() < pubkey_end {
        return Err(PaymentChannelError::InvalidSignature.into());
    }
    let pubkey_bytes = &ix_data[public_key_offset..pubkey_end];

    // Verify the public key matches the claimer
    if pubkey_bytes != claimer.as_ref() {
        return Err(PaymentChannelError::UnauthorizedSigner.into());
    }

    // Extract message from the instruction data
    let message_end = message_data_offset
        .checked_add(message_data_size)
        .ok_or::<ProgramError>(PaymentChannelError::InvalidSignature.into())?;
    if ix_data.len() < message_end {
        return Err(PaymentChannelError::InvalidSignature.into());
    }
    let message_bytes = &ix_data[message_data_offset..message_end];

    // Build expected balance proof: channel_pda (32) || nonce (8 LE) || transferred_amount (8 LE)
    // Uses a fixed-size array to avoid heap allocation in the BPF runtime.
    let mut expected_message = [0u8; 48];
    expected_message[0..32].copy_from_slice(channel_pda.as_ref());
    expected_message[32..40].copy_from_slice(&nonce.to_le_bytes());
    expected_message[40..48].copy_from_slice(&transferred_amount.to_le_bytes());

    // Verify message matches expected balance proof
    if message_bytes.len() != 48 || message_bytes != &expected_message[..] {
        return Err(PaymentChannelError::InvalidSignature.into());
    }

    Ok(())
}
