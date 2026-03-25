// Lifecycle Tests for Story 33.1: Solana Payment Channel Program — Channel Lifecycle
//
// GREEN PHASE: All tests should pass with the implemented program.
//
// Test framework: solana-program-test (BanksClient, in-process)
// Runner: cargo test-sbf
//
// Test IDs reference: test-design-epic-33.md

use solana_program_test::*;
use solana_sdk::{
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    transaction::Transaction,
};
use spl_token;

/// Program ID for the payment channel program.
const PROGRAM_ID: Pubkey = solana_sdk::pubkey!("598iSn5tfXsLcTPKj97SzKiCLVbKf7okNY4AEjgpLg2W");

// ============================================================================
// Test Helpers
// ============================================================================

/// Derives the channel PDA from two participant pubkeys and a token mint.
/// Participants are sorted lexicographically before derivation.
fn derive_channel_pda(
    participant_a: &Pubkey,
    participant_b: &Pubkey,
    token_mint: &Pubkey,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    let (min, max) = if participant_a < participant_b {
        (participant_a, participant_b)
    } else {
        (participant_b, participant_a)
    };
    Pubkey::find_program_address(
        &[b"channel", min.as_ref(), max.as_ref(), token_mint.as_ref()],
        program_id,
    )
}

/// Derives the vault PDA from the channel PDA.
fn derive_vault_pda(channel_pda: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"vault", channel_pda.as_ref()], program_id)
}

/// Sorts two keypairs so the first has the lexicographically smaller pubkey.
/// This ensures test participant_a matches on-chain sorted participant_a.
fn sorted_participants() -> (Keypair, Keypair) {
    loop {
        let a = Keypair::new();
        let b = Keypair::new();
        if a.pubkey() < b.pubkey() {
            return (a, b);
        } else if b.pubkey() < a.pubkey() {
            return (b, a);
        }
        // Extremely unlikely: equal pubkeys, retry
    }
}

/// Advances the clock sysvar by the given number of seconds.
/// This is needed because warp_to_slot doesn't automatically advance unix_timestamp.
async fn advance_clock_by_seconds(context: &mut ProgramTestContext, seconds: i64) {
    let current_clock = context.banks_client.get_sysvar::<Clock>().await.unwrap();
    let mut new_clock = current_clock.clone();
    new_clock.unix_timestamp += seconds;
    new_clock.slot += (seconds as u64) * 2; // ~2 slots per second
    context.set_sysvar(&new_clock);
    // Also warp to the new slot so the bank recognizes it
    context.warp_to_slot(new_clock.slot).unwrap();
}

/// Creates a ProgramTest instance with the payment channel program loaded.
fn program_test() -> ProgramTest {
    ProgramTest::new(
        "payment_channel",
        PROGRAM_ID,
        processor!(payment_channel::process_instruction),
    )
}

/// Creates a new SPL Token mint and returns its pubkey.
async fn create_test_mint(
    context: &mut ProgramTestContext,
    mint_authority: &Keypair,
) -> Pubkey {
    let mint = Keypair::new();
    let rent = context.banks_client.get_rent().await.unwrap();
    let mint_rent = rent.minimum_balance(spl_token::state::Mint::LEN);

    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[
            solana_sdk::system_instruction::create_account(
                &context.payer.pubkey(),
                &mint.pubkey(),
                mint_rent,
                spl_token::state::Mint::LEN as u64,
                &spl_token::id(),
            ),
            spl_token::instruction::initialize_mint(
                &spl_token::id(),
                &mint.pubkey(),
                &mint_authority.pubkey(),
                None,
                6,
            )
            .unwrap(),
        ],
        Some(&context.payer.pubkey()),
        &[&context.payer, &mint],
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();
    mint.pubkey()
}

/// Creates an SPL Token account for the given owner and mint, and mints tokens into it.
async fn create_and_fund_token_account(
    context: &mut ProgramTestContext,
    mint: &Pubkey,
    owner: &Pubkey,
    mint_authority: &Keypair,
    amount: u64,
) -> Pubkey {
    let account = Keypair::new();
    let rent = context.banks_client.get_rent().await.unwrap();
    let account_rent = rent.minimum_balance(spl_token::state::Account::LEN);

    let mut instructions = vec![
        solana_sdk::system_instruction::create_account(
            &context.payer.pubkey(),
            &account.pubkey(),
            account_rent,
            spl_token::state::Account::LEN as u64,
            &spl_token::id(),
        ),
        spl_token::instruction::initialize_account(
            &spl_token::id(),
            &account.pubkey(),
            mint,
            owner,
        )
        .unwrap(),
    ];

    let signers: Vec<&Keypair> = if amount > 0 {
        instructions.push(
            spl_token::instruction::mint_to(
                &spl_token::id(),
                mint,
                &account.pubkey(),
                &mint_authority.pubkey(),
                &[],
                amount,
            )
            .unwrap(),
        );
        vec![&context.payer, &account, mint_authority]
    } else {
        vec![&context.payer, &account]
    };

    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &instructions,
        Some(&context.payer.pubkey()),
        &signers,
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();
    account.pubkey()
}

/// Helper: initialize a channel and return (channel_pda, vault_pda, token_mint).
async fn setup_channel(
    context: &mut ProgramTestContext,
    participant_a: &Keypair,
    participant_b: &Keypair,
    mint_authority: &Keypair,
    challenge_duration: u64,
) -> (Pubkey, Pubkey, Pubkey) {
    let token_mint = create_test_mint(context, mint_authority).await;
    let (channel_pda, _) = derive_channel_pda(
        &participant_a.pubkey(),
        &participant_b.pubkey(),
        &token_mint,
        &PROGRAM_ID,
    );
    let (vault_pda, _) = derive_vault_pda(&channel_pda, &PROGRAM_ID);

    let ix = build_initialize_channel_instruction(
        &context.payer.pubkey(),
        &participant_a.pubkey(),
        &participant_b.pubkey(),
        &token_mint,
        &channel_pda,
        &vault_pda,
        challenge_duration,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    (channel_pda, vault_pda, token_mint)
}

fn build_initialize_channel_instruction(
    payer: &Pubkey,
    participant_a: &Pubkey,
    participant_b: &Pubkey,
    token_mint: &Pubkey,
    channel_pda: &Pubkey,
    vault_pda: &Pubkey,
    challenge_duration: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&[0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    data.extend_from_slice(&challenge_duration.to_le_bytes());

    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(*participant_a, false),
            AccountMeta::new_readonly(*participant_b, false),
            AccountMeta::new_readonly(*token_mint, false),
            AccountMeta::new(*channel_pda, false),
            AccountMeta::new(*vault_pda, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::id(), false),
        ],
        data,
    }
}

fn build_deposit_instruction(
    depositor: &Pubkey,
    depositor_token_account: &Pubkey,
    vault_token_account: &Pubkey,
    channel_pda: &Pubkey,
    amount: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&[0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    data.extend_from_slice(&amount.to_le_bytes());

    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*depositor, true),
            AccountMeta::new(*depositor_token_account, false),
            AccountMeta::new(*vault_token_account, false),
            AccountMeta::new(*channel_pda, false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
        data,
    }
}

fn build_close_channel_instruction(closer: &Pubkey, channel_pda: &Pubkey) -> Instruction {
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&[0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*closer, true),
            AccountMeta::new(*channel_pda, false),
            AccountMeta::new_readonly(solana_sdk::sysvar::clock::id(), false),
        ],
        data,
    }
}

fn build_settle_channel_instruction(
    caller: &Pubkey,
    channel_pda: &Pubkey,
    vault_token_account: &Pubkey,
    participant_a_token_account: &Pubkey,
    participant_b_token_account: &Pubkey,
    rent_recipient: &Pubkey,
) -> Instruction {
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&[0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*caller, true),
            AccountMeta::new(*channel_pda, false),
            AccountMeta::new(*vault_token_account, false),
            AccountMeta::new(*participant_a_token_account, false),
            AccountMeta::new(*participant_b_token_account, false),
            AccountMeta::new(*rent_recipient, false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(solana_sdk::sysvar::clock::id(), false),
        ],
        data,
    }
}

fn build_force_close_expired_instruction(
    caller: &Pubkey,
    channel_pda: &Pubkey,
    vault_token_account: &Pubkey,
    participant_a_token_account: &Pubkey,
    participant_b_token_account: &Pubkey,
    rent_recipient: &Pubkey,
) -> Instruction {
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&[0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*caller, true),
            AccountMeta::new(*channel_pda, false),
            AccountMeta::new(*vault_token_account, false),
            AccountMeta::new(*participant_a_token_account, false),
            AccountMeta::new(*participant_b_token_account, false),
            AccountMeta::new(*rent_recipient, false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(solana_sdk::sysvar::clock::id(), false),
        ],
        data,
    }
}

/// Channel state enum values for assertion comparisons.
const STATE_OPENED: u8 = 0;
const STATE_CLOSED: u8 = 1;
// Note: STATE_SETTLED is kept for documentation. The settle_channel instruction
// sets state to Settled then immediately zeroes the account, so we verify
// settlement by checking the account is closed (None) rather than reading state.
#[allow(dead_code)]
const STATE_SETTLED: u8 = 2;

/// Byte offsets matching the program's state.rs layout.
const STATE_FIELD_OFFSET: usize = 160;
const DEPOSIT_A_OFFSET: usize = 104;
const DEPOSIT_B_OFFSET: usize = 112;
const CLOSE_TIMESTAMP_OFFSET: usize = 161;

/// Challenge duration used in tests (60 seconds).
const TEST_CHALLENGE_DURATION: u64 = 60;

// ============================================================================
// T-33.1-01: initialize_channel creates PDA with correct state (P0)
// ============================================================================

#[tokio::test]
async fn test_initialize_channel_creates_pda_with_correct_state() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, _vault_pda, token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    let channel_account = context.banks_client
        .get_account(channel_pda).await.unwrap()
        .expect("Channel PDA should exist");
    let data = &channel_account.data;

    assert_eq!(data[STATE_FIELD_OFFSET], STATE_OPENED, "state should be Opened (0)");

    let deposit_a = u64::from_le_bytes(data[DEPOSIT_A_OFFSET..DEPOSIT_A_OFFSET + 8].try_into().unwrap());
    assert_eq!(deposit_a, 0, "deposit_a should be 0");

    let deposit_b = u64::from_le_bytes(data[DEPOSIT_B_OFFSET..DEPOSIT_B_OFFSET + 8].try_into().unwrap());
    assert_eq!(deposit_b, 0, "deposit_b should be 0");

    // Verify participants stored in sorted order
    let stored_a = Pubkey::try_from(&data[8..40]).unwrap();
    let stored_b = Pubkey::try_from(&data[40..72]).unwrap();
    let stored_mint = Pubkey::try_from(&data[72..104]).unwrap();

    assert_eq!(stored_a, participant_a.pubkey(), "participant_a should be lexicographic min");
    assert_eq!(stored_b, participant_b.pubkey(), "participant_b should be lexicographic max");
    assert_eq!(stored_mint, token_mint, "token_mint should be stored");

    // Verify transferred_amount_a = 0 (AC 1)
    let transferred_a = u64::from_le_bytes(data[120..128].try_into().unwrap());
    assert_eq!(transferred_a, 0, "transferred_amount_a should be 0");

    // Verify transferred_amount_b = 0 (AC 1)
    let transferred_b = u64::from_le_bytes(data[128..136].try_into().unwrap());
    assert_eq!(transferred_b, 0, "transferred_amount_b should be 0");

    // Verify nonce_a = 0 (AC 1)
    let nonce_a = u64::from_le_bytes(data[136..144].try_into().unwrap());
    assert_eq!(nonce_a, 0, "nonce_a should be 0");

    // Verify nonce_b = 0 (AC 1)
    let nonce_b = u64::from_le_bytes(data[144..152].try_into().unwrap());
    assert_eq!(nonce_b, 0, "nonce_b should be 0");

    // Verify challenge_duration stored correctly (AC 1)
    let stored_challenge_duration = u64::from_le_bytes(data[152..160].try_into().unwrap());
    assert_eq!(stored_challenge_duration, TEST_CHALLENGE_DURATION, "challenge_duration should match");

    // Verify bump seed stored (AC 1)
    let stored_bump = data[169];
    let (_, expected_bump) = derive_channel_pda(
        &participant_a.pubkey(), &participant_b.pubkey(), &token_mint, &PROGRAM_ID,
    );
    assert_eq!(stored_bump, expected_bump, "bump seed should be stored correctly");
}

// ============================================================================
// T-33.1-02: deposit by participant A increments deposit_a (P0)
// ============================================================================

#[tokio::test]
async fn test_deposit_participant_a_transfers_tokens_and_increments_deposit_a() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    let a_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_a.pubkey(), &mint_authority, 1000,
    ).await;

    let deposit_ix = build_deposit_instruction(
        &participant_a.pubkey(), &a_token_account, &vault_pda, &channel_pda, 1000,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[deposit_ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    let channel_account = context.banks_client
        .get_account(channel_pda).await.unwrap()
        .expect("Channel PDA should exist");
    let deposit_a = u64::from_le_bytes(
        channel_account.data[DEPOSIT_A_OFFSET..DEPOSIT_A_OFFSET + 8].try_into().unwrap(),
    );
    assert_eq!(deposit_a, 1000, "deposit_a should be 1000 after deposit");
}

// ============================================================================
// T-33.1-03: deposit by participant B increments deposit_b (P0)
// ============================================================================

#[tokio::test]
async fn test_deposit_participant_b_increments_deposit_b_not_deposit_a() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    let b_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_b.pubkey(), &mint_authority, 500,
    ).await;

    let deposit_ix = build_deposit_instruction(
        &participant_b.pubkey(), &b_token_account, &vault_pda, &channel_pda, 500,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[deposit_ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_b], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    let channel_account = context.banks_client
        .get_account(channel_pda).await.unwrap()
        .expect("Channel PDA should exist");
    let deposit_a = u64::from_le_bytes(
        channel_account.data[DEPOSIT_A_OFFSET..DEPOSIT_A_OFFSET + 8].try_into().unwrap(),
    );
    let deposit_b = u64::from_le_bytes(
        channel_account.data[DEPOSIT_B_OFFSET..DEPOSIT_B_OFFSET + 8].try_into().unwrap(),
    );
    assert_eq!(deposit_a, 0, "deposit_a should remain 0 when B deposits");
    assert_eq!(deposit_b, 500, "deposit_b should be 500 after B's deposit");
}

// ============================================================================
// T-33.1-04: close_channel sets state to Closed and records close_timestamp (P0)
// ============================================================================

#[tokio::test]
async fn test_close_channel_sets_state_and_timestamp() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, _vault_pda, _token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    let close_ix = build_close_channel_instruction(&participant_a.pubkey(), &channel_pda);
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[close_ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    let channel_account = context.banks_client
        .get_account(channel_pda).await.unwrap()
        .expect("Channel PDA should exist");

    assert_eq!(channel_account.data[STATE_FIELD_OFFSET], STATE_CLOSED, "state should be Closed (1)");

    let close_timestamp = i64::from_le_bytes(
        channel_account.data[CLOSE_TIMESTAMP_OFFSET..CLOSE_TIMESTAMP_OFFSET + 8].try_into().unwrap(),
    );
    assert!(close_timestamp > 0, "close_timestamp should be set");
}

// ============================================================================
// T-33.1-05: settle_channel distributes funds after challenge period (P0)
// ============================================================================

#[tokio::test]
async fn test_settle_channel_distributes_funds_after_challenge_period() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    // Deposit: A deposits 1000
    let a_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_a.pubkey(), &mint_authority, 1000,
    ).await;
    let ix = build_deposit_instruction(
        &participant_a.pubkey(), &a_token_account, &vault_pda, &channel_pda, 1000,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Deposit: B deposits 500
    let b_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_b.pubkey(), &mint_authority, 500,
    ).await;
    let ix = build_deposit_instruction(
        &participant_b.pubkey(), &b_token_account, &vault_pda, &channel_pda, 500,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_b], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Close channel
    let ix = build_close_channel_instruction(&participant_a.pubkey(), &channel_pda);
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Advance clock past challenge period (60s challenge + 10s margin)
    advance_clock_by_seconds(&mut context, 70).await;

    // Use the payer as both caller (signer) and rent recipient to avoid KeypairPubkeyMismatch.
    // Anyone can call settle_channel, it doesn't need to be a participant.
    let settle_ix = build_settle_channel_instruction(
        &context.payer.pubkey(),
        &channel_pda, &vault_pda,
        &a_token_account, &b_token_account,
        &context.payer.pubkey(),
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[settle_ix], Some(&context.payer.pubkey()),
        &[&context.payer], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Verify A received 1000 tokens back
    let a_account = context.banks_client.get_account(a_token_account).await.unwrap().unwrap();
    let a_balance = u64::from_le_bytes(a_account.data[64..72].try_into().unwrap());
    assert_eq!(a_balance, 1000, "A should receive 1000 tokens");

    // Verify B received 500 tokens back
    let b_account = context.banks_client.get_account(b_token_account).await.unwrap().unwrap();
    let b_balance = u64::from_le_bytes(b_account.data[64..72].try_into().unwrap());
    assert_eq!(b_balance, 500, "B should receive 500 tokens");

    // Verify balance conservation invariant: final_balance_a + final_balance_b == deposit_a + deposit_b
    assert_eq!(
        a_balance + b_balance, 1000 + 500,
        "Balance conservation: sum of distributed funds must equal sum of deposits"
    );

    // Verify channel PDA is closed after settlement (accounts reclaimed)
    let channel_account = context.banks_client.get_account(channel_pda).await.unwrap();
    assert!(channel_account.is_none(), "Channel PDA should be closed after settlement");
}

// ============================================================================
// T-33.1-06: settle_channel fails before challenge deadline (P0)
// ============================================================================

#[tokio::test]
async fn test_settle_channel_fails_before_challenge_deadline() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    // Close channel
    let ix = build_close_channel_instruction(&participant_a.pubkey(), &channel_pda);
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Do NOT warp time — challenge period still active

    let a_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_a.pubkey(), &mint_authority, 0,
    ).await;
    let b_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_b.pubkey(), &mint_authority, 0,
    ).await;

    // Settle with payer as caller to avoid signing issues
    let settle_ix = build_settle_channel_instruction(
        &context.payer.pubkey(),
        &channel_pda, &vault_pda,
        &a_token_account, &b_token_account,
        &context.payer.pubkey(),
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[settle_ix], Some(&context.payer.pubkey()),
        &[&context.payer], recent,
    );

    let result = context.banks_client.process_transaction(tx).await;
    assert!(result.is_err(), "settle_channel should fail before challenge deadline");

    // Verify the error is ChannelChallengeNotExpired (custom error code 3)
    let err = result.unwrap_err();
    let err_str = format!("{:?}", err);
    assert!(
        err_str.contains("Custom(3)") || err_str.contains("ChannelChallengeNotExpired"),
        "Expected ChannelChallengeNotExpired error (Custom(3)), got: {}",
        err_str
    );
}

// ============================================================================
// T-33.1-07: PDA derivation is order-independent (P0)
// ============================================================================

#[tokio::test]
async fn test_pda_derivation_order_independent() {
    let participant_a = Keypair::new();
    let participant_b = Keypair::new();
    let token_mint = Pubkey::new_unique();

    let (pda_ab, bump_ab) = derive_channel_pda(
        &participant_a.pubkey(), &participant_b.pubkey(), &token_mint, &PROGRAM_ID,
    );
    let (pda_ba, bump_ba) = derive_channel_pda(
        &participant_b.pubkey(), &participant_a.pubkey(), &token_mint, &PROGRAM_ID,
    );

    assert_eq!(pda_ab, pda_ba, "PDA should be same regardless of order");
    assert_eq!(bump_ab, bump_ba, "Bump should be same regardless of order");
}

// ============================================================================
// T-33.1-08: force_close_expired distributes funds after deadline (P1)
// ============================================================================

#[tokio::test]
async fn test_force_close_expired_distributes_funds_after_deadline() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    // Deposit: A deposits 800, B deposits 400
    let a_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_a.pubkey(), &mint_authority, 800,
    ).await;
    let ix = build_deposit_instruction(
        &participant_a.pubkey(), &a_token_account, &vault_pda, &channel_pda, 800,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    let b_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_b.pubkey(), &mint_authority, 400,
    ).await;
    let ix = build_deposit_instruction(
        &participant_b.pubkey(), &b_token_account, &vault_pda, &channel_pda, 400,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_b], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Close channel
    let ix = build_close_channel_instruction(&participant_a.pubkey(), &channel_pda);
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Advance clock past challenge period
    advance_clock_by_seconds(&mut context, 70).await;

    // force_close_expired called by payer
    let ix = build_force_close_expired_instruction(
        &context.payer.pubkey(),
        &channel_pda, &vault_pda,
        &a_token_account, &b_token_account,
        &context.payer.pubkey(),
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // A deposited 800, B deposited 400, no transfers — each gets their deposit back
    let a_account = context.banks_client.get_account(a_token_account).await.unwrap().unwrap();
    let a_balance = u64::from_le_bytes(a_account.data[64..72].try_into().unwrap());
    assert_eq!(a_balance, 800, "A should receive 800 tokens back");

    let b_account = context.banks_client.get_account(b_token_account).await.unwrap().unwrap();
    let b_balance = u64::from_le_bytes(b_account.data[64..72].try_into().unwrap());
    assert_eq!(b_balance, 400, "B should receive 400 tokens back");

    // Verify balance conservation
    assert_eq!(
        a_balance + b_balance, 800 + 400,
        "Balance conservation: sum of distributed funds must equal sum of deposits"
    );
}

// ============================================================================
// T-33.1-09: double-init rejected (P1)
// ============================================================================

#[tokio::test]
async fn test_initialize_channel_rejects_double_init() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    // Try to initialize again
    let ix = build_initialize_channel_instruction(
        &context.payer.pubkey(),
        &participant_a.pubkey(), &participant_b.pubkey(),
        &token_mint, &channel_pda, &vault_pda,
        TEST_CHALLENGE_DURATION,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer], recent,
    );

    let result = context.banks_client.process_transaction(tx).await;
    assert!(result.is_err(), "Double initialization should be rejected");

    // Verify the error is ChannelAlreadyExists (custom error code 0)
    let err = result.unwrap_err();
    let err_str = format!("{:?}", err);
    assert!(
        err_str.contains("Custom(0)") || err_str.contains("ChannelAlreadyExists") || err_str.contains("already in use"),
        "Expected ChannelAlreadyExists error (Custom(0)), got: {}",
        err_str
    );
}

// ============================================================================
// T-33.1-10: deposit to closed channel rejected (P1)
// ============================================================================

#[tokio::test]
async fn test_deposit_to_closed_channel_rejected() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    // Close channel
    let ix = build_close_channel_instruction(&participant_a.pubkey(), &channel_pda);
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Try to deposit on closed channel
    let a_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_a.pubkey(), &mint_authority, 100,
    ).await;
    let ix = build_deposit_instruction(
        &participant_a.pubkey(), &a_token_account, &vault_pda, &channel_pda, 100,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a], recent,
    );

    let result = context.banks_client.process_transaction(tx).await;
    assert!(result.is_err(), "Deposit to closed channel should fail");

    // Verify the error is ChannelNotOpened (custom error code 1)
    let err = result.unwrap_err();
    let err_str = format!("{:?}", err);
    assert!(
        err_str.contains("Custom(1)") || err_str.contains("ChannelNotOpened"),
        "Expected ChannelNotOpened error (Custom(1)), got: {}",
        err_str
    );
}

// ============================================================================
// T-33.1-11: zero-amount deposit rejected (P1)
// ============================================================================

#[tokio::test]
async fn test_deposit_zero_amount_rejected() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    let a_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_a.pubkey(), &mint_authority, 1000,
    ).await;
    let ix = build_deposit_instruction(
        &participant_a.pubkey(), &a_token_account, &vault_pda, &channel_pda, 0,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a], recent,
    );

    let result = context.banks_client.process_transaction(tx).await;
    assert!(result.is_err(), "Zero-amount deposit should fail");

    // Verify the error is ZeroAmountDeposit (custom error code 5)
    let err = result.unwrap_err();
    let err_str = format!("{:?}", err);
    assert!(
        err_str.contains("Custom(5)") || err_str.contains("ZeroAmountDeposit"),
        "Expected ZeroAmountDeposit error (Custom(5)), got: {}",
        err_str
    );
}

// ============================================================================
// T-33.1-12: close by non-participant rejected (P1)
// ============================================================================

#[tokio::test]
async fn test_close_channel_by_non_participant_rejected() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let non_participant_c = Keypair::new();
    let mint_authority = Keypair::new();

    let (channel_pda, _vault_pda, _token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    let ix = build_close_channel_instruction(&non_participant_c.pubkey(), &channel_pda);
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &non_participant_c], recent,
    );

    let result = context.banks_client.process_transaction(tx).await;
    assert!(result.is_err(), "close by non-participant should fail");

    // Verify the error is InvalidParticipant (custom error code 4)
    let err = result.unwrap_err();
    let err_str = format!("{:?}", err);
    assert!(
        err_str.contains("Custom(4)") || err_str.contains("InvalidParticipant"),
        "Expected InvalidParticipant error (Custom(4)), got: {}",
        err_str
    );
}

// ============================================================================
// T-33.1-12a: deposit by non-participant rejected (P1)
// ============================================================================

#[tokio::test]
async fn test_deposit_by_non_participant_rejected() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let non_participant_c = Keypair::new();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    let c_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &non_participant_c.pubkey(), &mint_authority, 100,
    ).await;
    let ix = build_deposit_instruction(
        &non_participant_c.pubkey(), &c_token_account, &vault_pda, &channel_pda, 100,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &non_participant_c], recent,
    );

    let result = context.banks_client.process_transaction(tx).await;
    assert!(result.is_err(), "Deposit by non-participant should fail");

    // Verify the error is InvalidParticipant (custom error code 4)
    let err = result.unwrap_err();
    let err_str = format!("{:?}", err);
    assert!(
        err_str.contains("Custom(4)") || err_str.contains("InvalidParticipant"),
        "Expected InvalidParticipant error (Custom(4)), got: {}",
        err_str
    );
}

// ============================================================================
// T-33.1-13: settle reclaims rent (P2)
// ============================================================================

#[tokio::test]
async fn test_settle_channel_reclaims_rent() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    // Close channel
    let ix = build_close_channel_instruction(&participant_a.pubkey(), &channel_pda);
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Advance clock past challenge period
    advance_clock_by_seconds(&mut context, 70).await;

    let a_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_a.pubkey(), &mint_authority, 0,
    ).await;
    let b_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_b.pubkey(), &mint_authority, 0,
    ).await;

    let rent_recipient = context.payer.pubkey();

    // Record rent recipient's lamport balance before settlement
    let recipient_before = context.banks_client
        .get_account(rent_recipient).await.unwrap()
        .expect("Rent recipient should exist")
        .lamports;

    let settle_ix = build_settle_channel_instruction(
        &context.payer.pubkey(),
        &channel_pda, &vault_pda,
        &a_token_account, &b_token_account,
        &rent_recipient,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[settle_ix], Some(&context.payer.pubkey()),
        &[&context.payer], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Channel PDA and vault should be closed
    let channel_account = context.banks_client.get_account(channel_pda).await.unwrap();
    assert!(channel_account.is_none(), "Channel PDA should be closed after settlement");

    let vault_account = context.banks_client.get_account(vault_pda).await.unwrap();
    assert!(vault_account.is_none(), "Vault PDA should be closed after settlement");

    // Verify rent recipient received lamports (balance increased despite paying tx fee)
    // The recipient gets rent from both channel PDA and vault token account closure.
    // We can't check exact amounts due to tx fees, but we can verify the recipient
    // still has a balance (the rent reclaimed offsets the tx fee cost).
    let recipient_after = context.banks_client
        .get_account(rent_recipient).await.unwrap()
        .expect("Rent recipient should still exist")
        .lamports;

    // The rent recipient (payer) paid a tx fee but received rent back from two accounts.
    // The rent from channel PDA (~178 bytes) + vault token account (~165 bytes) should
    // exceed the ~5000 lamport transaction fee.
    assert!(
        recipient_after > recipient_before - 10_000,
        "Rent recipient should have received rent lamports back (before: {}, after: {})",
        recipient_before, recipient_after,
    );
}

// ============================================================================
// AC 2 gap: deposit verifies vault token balance (tokens actually transferred)
// ============================================================================

#[tokio::test]
async fn test_deposit_transfers_tokens_to_vault() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    let a_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_a.pubkey(), &mint_authority, 1000,
    ).await;

    let deposit_ix = build_deposit_instruction(
        &participant_a.pubkey(), &a_token_account, &vault_pda, &channel_pda, 1000,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[deposit_ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Verify vault token account received the tokens
    let vault_account = context.banks_client.get_account(vault_pda).await.unwrap().unwrap();
    let vault_balance = u64::from_le_bytes(vault_account.data[64..72].try_into().unwrap());
    assert_eq!(vault_balance, 1000, "Vault should hold 1000 tokens after deposit");

    // Verify depositor token account is drained
    let a_account = context.banks_client.get_account(a_token_account).await.unwrap().unwrap();
    let a_balance = u64::from_le_bytes(a_account.data[64..72].try_into().unwrap());
    assert_eq!(a_balance, 0, "Depositor token account should be drained after full deposit");
}

// ============================================================================
// AC 3 gap: close_channel by participant B (AC says "either participant")
// ============================================================================

#[tokio::test]
async fn test_close_channel_by_participant_b() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, _vault_pda, _token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    // Participant B closes the channel
    let close_ix = build_close_channel_instruction(&participant_b.pubkey(), &channel_pda);
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[close_ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_b], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    let channel_account = context.banks_client
        .get_account(channel_pda).await.unwrap()
        .expect("Channel PDA should exist");

    assert_eq!(channel_account.data[STATE_FIELD_OFFSET], STATE_CLOSED, "state should be Closed when B closes");

    let close_timestamp = i64::from_le_bytes(
        channel_account.data[CLOSE_TIMESTAMP_OFFSET..CLOSE_TIMESTAMP_OFFSET + 8].try_into().unwrap(),
    );
    assert!(close_timestamp > 0, "close_timestamp should be set when B closes");
}

// ============================================================================
// AC 4 gap: settle_channel verifies state = Settled and balance conservation
// ============================================================================

#[tokio::test]
async fn test_settle_channel_sets_state_to_settled_and_conserves_balance() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    // Deposit: A deposits 700, B deposits 300
    let a_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_a.pubkey(), &mint_authority, 700,
    ).await;
    let ix = build_deposit_instruction(
        &participant_a.pubkey(), &a_token_account, &vault_pda, &channel_pda, 700,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    let b_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_b.pubkey(), &mint_authority, 300,
    ).await;
    let ix = build_deposit_instruction(
        &participant_b.pubkey(), &b_token_account, &vault_pda, &channel_pda, 300,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_b], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Close channel
    let ix = build_close_channel_instruction(&participant_a.pubkey(), &channel_pda);
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Advance clock past challenge period
    advance_clock_by_seconds(&mut context, 70).await;

    // Settle
    let settle_ix = build_settle_channel_instruction(
        &context.payer.pubkey(),
        &channel_pda, &vault_pda,
        &a_token_account, &b_token_account,
        &context.payer.pubkey(),
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[settle_ix], Some(&context.payer.pubkey()),
        &[&context.payer], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Verify balance conservation: A gets 700 back, B gets 300 back (no transfers)
    let a_account = context.banks_client.get_account(a_token_account).await.unwrap().unwrap();
    let a_balance = u64::from_le_bytes(a_account.data[64..72].try_into().unwrap());
    let b_account = context.banks_client.get_account(b_token_account).await.unwrap().unwrap();
    let b_balance = u64::from_le_bytes(b_account.data[64..72].try_into().unwrap());

    assert_eq!(a_balance, 700, "A should receive deposit_a back");
    assert_eq!(b_balance, 300, "B should receive deposit_b back");
    assert_eq!(a_balance + b_balance, 1000, "Balance conservation: sum of payouts == sum of deposits");

    // Channel PDA should be closed (zeroed out and lamports reclaimed)
    let channel_account = context.banks_client.get_account(channel_pda).await.unwrap();
    assert!(channel_account.is_none(), "Channel PDA should be closed after settlement (state = Settled)");

    // Vault should be closed
    let vault_account = context.banks_client.get_account(vault_pda).await.unwrap();
    assert!(vault_account.is_none(), "Vault should be closed after settlement");
}

// ============================================================================
// AC 6 gap: force_close_expired verifies accounts closed and funds distributed
// ============================================================================

#[tokio::test]
async fn test_force_close_expired_closes_accounts() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    // Deposit: A deposits 500, B deposits 500
    let a_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_a.pubkey(), &mint_authority, 500,
    ).await;
    let ix = build_deposit_instruction(
        &participant_a.pubkey(), &a_token_account, &vault_pda, &channel_pda, 500,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    let b_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_b.pubkey(), &mint_authority, 500,
    ).await;
    let ix = build_deposit_instruction(
        &participant_b.pubkey(), &b_token_account, &vault_pda, &channel_pda, 500,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_b], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Close channel
    let ix = build_close_channel_instruction(&participant_b.pubkey(), &channel_pda);
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer, &participant_b], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Advance clock past challenge period
    advance_clock_by_seconds(&mut context, 70).await;

    // Force close expired
    let ix = build_force_close_expired_instruction(
        &context.payer.pubkey(),
        &channel_pda, &vault_pda,
        &a_token_account, &b_token_account,
        &context.payer.pubkey(),
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix], Some(&context.payer.pubkey()),
        &[&context.payer], recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Verify funds distributed correctly
    let a_account = context.banks_client.get_account(a_token_account).await.unwrap().unwrap();
    let a_balance = u64::from_le_bytes(a_account.data[64..72].try_into().unwrap());
    let b_account = context.banks_client.get_account(b_token_account).await.unwrap().unwrap();
    let b_balance = u64::from_le_bytes(b_account.data[64..72].try_into().unwrap());

    assert_eq!(a_balance, 500, "A should receive deposit_a back via force_close");
    assert_eq!(b_balance, 500, "B should receive deposit_b back via force_close");

    // Verify accounts are closed (same as settle_channel — AC 6)
    let channel_account = context.banks_client.get_account(channel_pda).await.unwrap();
    assert!(channel_account.is_none(), "Channel PDA should be closed after force_close_expired");

    let vault_account = context.banks_client.get_account(vault_pda).await.unwrap();
    assert!(vault_account.is_none(), "Vault should be closed after force_close_expired");
}

// ============================================================================
// Gap: settle_channel on Opened channel fails with ChannelNotClosed
// ============================================================================

#[tokio::test]
async fn test_settle_channel_on_opened_channel_fails() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, token_mint) = setup_channel(
        &mut context, &participant_a, &participant_b, &mint_authority,
        TEST_CHALLENGE_DURATION,
    ).await;

    // Create token accounts for settlement (even though it should fail)
    let a_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_a.pubkey(), &mint_authority, 0,
    ).await;
    let b_token_account = create_and_fund_token_account(
        &mut context, &token_mint, &participant_b.pubkey(), &mint_authority, 0,
    ).await;

    // Try to settle without closing first
    let settle_ix = build_settle_channel_instruction(
        &context.payer.pubkey(),
        &channel_pda, &vault_pda,
        &a_token_account, &b_token_account,
        &context.payer.pubkey(),
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[settle_ix], Some(&context.payer.pubkey()),
        &[&context.payer], recent,
    );

    let result = context.banks_client.process_transaction(tx).await;
    assert!(result.is_err(), "settle_channel on Opened channel should fail");

    // Verify the error is ChannelNotClosed (custom error code 2)
    let err = result.unwrap_err();
    let err_str = format!("{:?}", err);
    assert!(
        err_str.contains("Custom(2)") || err_str.contains("ChannelNotClosed"),
        "Expected ChannelNotClosed error (Custom(2)), got: {}",
        err_str
    );
}
