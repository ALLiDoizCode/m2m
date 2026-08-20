// Integration Tests for Story 33.3: Full Lifecycle End-to-End Tests
//
// These tests validate the complete payment channel lifecycle:
//   initialize -> deposit -> claim -> close -> settle
// with balance conservation invariants verified at every state transition.
//
// Test IDs: T-33.3-01, T-33.3-02, T-33.3-03
//
// Test framework: solana-program-test (BanksClient, in-process)
// Runner: cargo test-sbf

use solana_program_test::*;
use solana_sdk::{
    clock::Clock,
    ed25519_instruction::new_ed25519_instruction,
    instruction::{AccountMeta, Instruction},
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program, sysvar,
    transaction::Transaction,
};

/// Program ID for the payment channel program.
const PROGRAM_ID: Pubkey = solana_sdk::pubkey!("598iSn5tfXsLcTPKj97SzKiCLVbKf7okNY4AEjgpLg2W");

/// Challenge duration used in tests (60 seconds).
const TEST_CHALLENGE_DURATION: u64 = 60;

/// Byte offsets matching the program's state.rs layout.
const DEPOSIT_A_OFFSET: usize = 104;
const DEPOSIT_B_OFFSET: usize = 112;
const TRANSFERRED_AMOUNT_A_OFFSET: usize = 120;
const TRANSFERRED_AMOUNT_B_OFFSET: usize = 128;
const NONCE_A_OFFSET: usize = 136;
const NONCE_B_OFFSET: usize = 144;
const STATE_FIELD_OFFSET: usize = 160;

const STATE_OPENED: u8 = 0;
const STATE_CLOSED: u8 = 1;

// ============================================================================
// Test Helpers (duplicated from lifecycle.rs / claims.rs for test isolation)
// ============================================================================

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

fn derive_vault_pda(channel_pda: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"vault", channel_pda.as_ref()], program_id)
}

fn sorted_participants() -> (Keypair, Keypair) {
    loop {
        let a = Keypair::new();
        let b = Keypair::new();
        if a.pubkey() < b.pubkey() {
            return (a, b);
        } else if b.pubkey() < a.pubkey() {
            return (b, a);
        }
    }
}

fn program_test() -> ProgramTest {
    ProgramTest::new(
        "payment_channel",
        PROGRAM_ID,
        processor!(payment_channel::process_instruction),
    )
}

async fn create_test_mint(context: &mut ProgramTestContext, mint_authority: &Keypair) -> Pubkey {
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
            AccountMeta::new_readonly(sysvar::rent::id(), false),
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
            AccountMeta::new_readonly(sysvar::clock::id(), false),
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
            AccountMeta::new_readonly(sysvar::clock::id(), false),
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
            AccountMeta::new_readonly(sysvar::clock::id(), false),
        ],
        data,
    }
}

fn build_claim_instruction(
    fee_payer: &Pubkey,
    claimer: &Pubkey,
    channel_pda: &Pubkey,
    nonce: u64,
    transferred_amount: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&[0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    data.extend_from_slice(&nonce.to_le_bytes());
    data.extend_from_slice(&transferred_amount.to_le_bytes());

    // Account layout (#99): fee-payer/submitter signs the tx; the claiming
    // participant (claimer) is a non-signer authorized via the Ed25519 precompile.
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*fee_payer, true),
            AccountMeta::new_readonly(*claimer, false),
            AccountMeta::new(*channel_pda, false),
            AccountMeta::new_readonly(sysvar::instructions::id(), false),
        ],
        data,
    }
}

fn build_balance_proof_message(
    program_id: &Pubkey,
    channel_pda: &Pubkey,
    nonce: u64,
    transferred_amount: u64,
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(96);
    msg.extend_from_slice(b"TOON-BALPROOF-V2");
    msg.extend_from_slice(program_id.as_ref());
    msg.extend_from_slice(channel_pda.as_ref());
    msg.extend_from_slice(&nonce.to_le_bytes());
    msg.extend_from_slice(&transferred_amount.to_le_bytes());
    msg
}

fn to_dalek_keypair(keypair: &Keypair) -> ed25519_dalek::Keypair {
    ed25519_dalek::Keypair::from_bytes(&keypair.to_bytes()).unwrap()
}

/// Full setup: initialize channel, deposit tokens for both participants.
/// Returns (channel_pda, vault_pda, token_mint, token_account_a, token_account_b).
async fn setup_funded_channel(
    context: &mut ProgramTestContext,
    participant_a: &Keypair,
    participant_b: &Keypair,
    mint_authority: &Keypair,
    deposit_a: u64,
    deposit_b: u64,
) -> (Pubkey, Pubkey, Pubkey, Pubkey, Pubkey) {
    let token_mint = create_test_mint(context, mint_authority).await;
    let (channel_pda, _) = derive_channel_pda(
        &participant_a.pubkey(),
        &participant_b.pubkey(),
        &token_mint,
        &PROGRAM_ID,
    );
    let (vault_pda, _) = derive_vault_pda(&channel_pda, &PROGRAM_ID);

    // Initialize channel
    let ix = build_initialize_channel_instruction(
        &context.payer.pubkey(),
        &participant_a.pubkey(),
        &participant_b.pubkey(),
        &token_mint,
        &channel_pda,
        &vault_pda,
        TEST_CHALLENGE_DURATION,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Create and fund token accounts
    let token_account_a = create_and_fund_token_account(
        context,
        &token_mint,
        &participant_a.pubkey(),
        mint_authority,
        deposit_a,
    )
    .await;
    let token_account_b = create_and_fund_token_account(
        context,
        &token_mint,
        &participant_b.pubkey(),
        mint_authority,
        deposit_b,
    )
    .await;

    // Deposit for participant A
    if deposit_a > 0 {
        let ix = build_deposit_instruction(
            &participant_a.pubkey(),
            &token_account_a,
            &vault_pda,
            &channel_pda,
            deposit_a,
        );
        let recent = context.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&context.payer.pubkey()),
            &[&context.payer, participant_a],
            recent,
        );
        context.banks_client.process_transaction(tx).await.unwrap();
    }

    // Deposit for participant B
    if deposit_b > 0 {
        let ix = build_deposit_instruction(
            &participant_b.pubkey(),
            &token_account_b,
            &vault_pda,
            &channel_pda,
            deposit_b,
        );
        let recent = context.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&context.payer.pubkey()),
            &[&context.payer, participant_b],
            recent,
        );
        context.banks_client.process_transaction(tx).await.unwrap();
    }

    (
        channel_pda,
        vault_pda,
        token_mint,
        token_account_a,
        token_account_b,
    )
}

/// Submit a claim transaction with Ed25519 precompile at index 0.
async fn submit_claim(
    context: &mut ProgramTestContext,
    claimer: &Keypair,
    channel_pda: &Pubkey,
    nonce: u64,
    transferred_amount: u64,
) -> Result<(), solana_program_test::BanksClientError> {
    let message = build_balance_proof_message(&PROGRAM_ID, channel_pda, nonce, transferred_amount);
    let dalek_keypair = to_dalek_keypair(claimer);
    let ed25519_ix = new_ed25519_instruction(&dalek_keypair, &message);
    let claim_ix = build_claim_instruction(
        &context.payer.pubkey(),
        &claimer.pubkey(),
        channel_pda,
        nonce,
        transferred_amount,
    );

    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ed25519_ix, claim_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        recent,
    );
    context.banks_client.process_transaction(tx).await
}

/// Read a u64 from account data at a given offset.
fn read_u64_at(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

/// Get the token balance from an SPL token account.
fn read_token_balance(account_data: &[u8]) -> u64 {
    u64::from_le_bytes(account_data[64..72].try_into().unwrap())
}

/// Get the vault token balance.
async fn get_vault_balance(context: &mut ProgramTestContext, vault_pda: &Pubkey) -> u64 {
    let account = context
        .banks_client
        .get_account(*vault_pda)
        .await
        .unwrap()
        .expect("Vault should exist");
    read_token_balance(&account.data)
}

/// Advances the clock sysvar by the given number of seconds.
async fn advance_clock_by_seconds(context: &mut ProgramTestContext, seconds: i64) {
    let current_clock = context.banks_client.get_sysvar::<Clock>().await.unwrap();
    let mut new_clock = current_clock.clone();
    new_clock.unix_timestamp += seconds;
    new_clock.slot += (seconds as u64) * 2;
    context.set_sysvar(&new_clock);
    context.warp_to_slot(new_clock.slot).unwrap();
}

// ============================================================================
// T-33.3-01: Full lifecycle — open -> deposit -> claim -> close -> settle (P0)
// AC 1: Complete lifecycle passes end-to-end
// ============================================================================

#[tokio::test]
async fn test_full_lifecycle_open_deposit_claim_close_settle() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let initial_deposit_a: u64 = 10_000;
    let initial_deposit_b: u64 = 5_000;

    // Step 1: Initialize and deposit
    let (channel_pda, vault_pda, _token_mint, token_account_a, token_account_b) =
        setup_funded_channel(
            &mut context,
            &participant_a,
            &participant_b,
            &mint_authority,
            initial_deposit_a,
            initial_deposit_b,
        )
        .await;

    // Verify channel is in Opened state
    let account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .expect("Channel should exist");
    assert_eq!(account.data[STATE_FIELD_OFFSET], STATE_OPENED);

    // Step 2: Claims — A claims 3000 transferred, B claims 1000 transferred
    submit_claim(&mut context, &participant_a, &channel_pda, 1, 3000)
        .await
        .unwrap();
    submit_claim(&mut context, &participant_b, &channel_pda, 1, 1000)
        .await
        .unwrap();

    // Verify claims updated state correctly
    let account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .expect("Channel should exist");
    assert_eq!(read_u64_at(&account.data, NONCE_A_OFFSET), 1);
    assert_eq!(
        read_u64_at(&account.data, TRANSFERRED_AMOUNT_A_OFFSET),
        3000
    );
    assert_eq!(read_u64_at(&account.data, NONCE_B_OFFSET), 1);
    assert_eq!(
        read_u64_at(&account.data, TRANSFERRED_AMOUNT_B_OFFSET),
        1000
    );

    // Step 3: Close channel
    let close_ix = build_close_channel_instruction(&participant_a.pubkey(), &channel_pda);
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[close_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a],
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Verify channel is now Closed
    let account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .expect("Channel should exist");
    assert_eq!(account.data[STATE_FIELD_OFFSET], STATE_CLOSED);

    // Step 4: Advance clock past challenge period and settle
    advance_clock_by_seconds(&mut context, (TEST_CHALLENGE_DURATION + 10) as i64).await;

    let settle_ix = build_settle_channel_instruction(
        &context.payer.pubkey(),
        &channel_pda,
        &vault_pda,
        &token_account_a,
        &token_account_b,
        &context.payer.pubkey(),
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[settle_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Step 5: Verify final balances
    // A gets: deposit_a - transferred_amount_a + transferred_amount_b = 10000 - 3000 + 1000 = 8000
    // B gets: deposit_b - transferred_amount_b + transferred_amount_a = 5000 - 1000 + 3000 = 7000
    let a_account = context
        .banks_client
        .get_account(token_account_a)
        .await
        .unwrap()
        .unwrap();
    let a_balance = read_token_balance(&a_account.data);
    assert_eq!(
        a_balance, 8000,
        "A should receive deposit_a - transferred_a + transferred_b"
    );

    let b_account = context
        .banks_client
        .get_account(token_account_b)
        .await
        .unwrap()
        .unwrap();
    let b_balance = read_token_balance(&b_account.data);
    assert_eq!(
        b_balance, 7000,
        "B should receive deposit_b - transferred_b + transferred_a"
    );

    // Verify balance conservation (AC 3)
    assert_eq!(
        a_balance + b_balance,
        initial_deposit_a + initial_deposit_b,
        "Balance conservation: final_a + final_b == initial_deposit_a + initial_deposit_b"
    );

    // Verify channel PDA is closed after settlement
    let channel_account = context.banks_client.get_account(channel_pda).await.unwrap();
    assert!(
        channel_account.is_none(),
        "Channel PDA should be closed after settlement"
    );
}

// ============================================================================
// T-33.3-01b: Full lifecycle with force_close_expired path (P0)
// AC 1: Alternate settlement path
// ============================================================================

#[tokio::test]
async fn test_full_lifecycle_with_force_close_expired() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let initial_deposit_a: u64 = 8_000;
    let initial_deposit_b: u64 = 4_000;

    let (channel_pda, vault_pda, _token_mint, token_account_a, token_account_b) =
        setup_funded_channel(
            &mut context,
            &participant_a,
            &participant_b,
            &mint_authority,
            initial_deposit_a,
            initial_deposit_b,
        )
        .await;

    // Claims: A transfers 2000, B transfers 500
    submit_claim(&mut context, &participant_a, &channel_pda, 1, 2000)
        .await
        .unwrap();
    submit_claim(&mut context, &participant_b, &channel_pda, 1, 500)
        .await
        .unwrap();

    // Close
    let close_ix = build_close_channel_instruction(&participant_b.pubkey(), &channel_pda);
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[close_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, &participant_b],
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Advance clock and use force_close_expired
    advance_clock_by_seconds(&mut context, (TEST_CHALLENGE_DURATION + 10) as i64).await;

    let ix = build_force_close_expired_instruction(
        &context.payer.pubkey(),
        &channel_pda,
        &vault_pda,
        &token_account_a,
        &token_account_b,
        &context.payer.pubkey(),
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // A gets: 8000 - 2000 + 500 = 6500
    // B gets: 4000 - 500 + 2000 = 5500
    let a_account = context
        .banks_client
        .get_account(token_account_a)
        .await
        .unwrap()
        .unwrap();
    let a_balance = read_token_balance(&a_account.data);
    assert_eq!(a_balance, 6500);

    let b_account = context
        .banks_client
        .get_account(token_account_b)
        .await
        .unwrap()
        .unwrap();
    let b_balance = read_token_balance(&b_account.data);
    assert_eq!(b_balance, 5500);

    assert_eq!(
        a_balance + b_balance,
        initial_deposit_a + initial_deposit_b,
        "Balance conservation with force_close_expired"
    );
}

// ============================================================================
// T-33.3-02: Vault balance == deposit_a + deposit_b at every state transition (P0)
// AC 2: Balance conservation — vault invariant
// ============================================================================

#[tokio::test]
async fn test_vault_balance_equals_deposits_at_every_state_transition() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let token_mint = create_test_mint(&mut context, &mint_authority).await;
    let (channel_pda, _) = derive_channel_pda(
        &participant_a.pubkey(),
        &participant_b.pubkey(),
        &token_mint,
        &PROGRAM_ID,
    );
    let (vault_pda, _) = derive_vault_pda(&channel_pda, &PROGRAM_ID);

    // Initialize channel
    let ix = build_initialize_channel_instruction(
        &context.payer.pubkey(),
        &participant_a.pubkey(),
        &participant_b.pubkey(),
        &token_mint,
        &channel_pda,
        &vault_pda,
        TEST_CHALLENGE_DURATION,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // After init: vault balance = 0
    let vault_balance = get_vault_balance(&mut context, &vault_pda).await;
    assert_eq!(vault_balance, 0, "Vault should be empty after init");

    // Deposit A: 5000
    let token_account_a = create_and_fund_token_account(
        &mut context,
        &token_mint,
        &participant_a.pubkey(),
        &mint_authority,
        5000,
    )
    .await;
    let ix = build_deposit_instruction(
        &participant_a.pubkey(),
        &token_account_a,
        &vault_pda,
        &channel_pda,
        5000,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a],
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // After deposit A: vault = 5000
    let vault_balance = get_vault_balance(&mut context, &vault_pda).await;
    assert_eq!(vault_balance, 5000, "Vault should be 5000 after A deposits");

    // Deposit B: 3000
    let token_account_b = create_and_fund_token_account(
        &mut context,
        &token_mint,
        &participant_b.pubkey(),
        &mint_authority,
        3000,
    )
    .await;
    let ix = build_deposit_instruction(
        &participant_b.pubkey(),
        &token_account_b,
        &vault_pda,
        &channel_pda,
        3000,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, &participant_b],
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // After deposit B: vault = 5000 + 3000 = 8000
    let vault_balance = get_vault_balance(&mut context, &vault_pda).await;
    assert_eq!(
        vault_balance, 8000,
        "Vault should be 8000 after both deposits"
    );

    // Verify vault == deposit_a + deposit_b
    let channel_account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .unwrap();
    let deposit_a = read_u64_at(&channel_account.data, DEPOSIT_A_OFFSET);
    let deposit_b = read_u64_at(&channel_account.data, DEPOSIT_B_OFFSET);
    assert_eq!(
        vault_balance,
        deposit_a + deposit_b,
        "Vault balance must equal deposit_a + deposit_b"
    );

    // After claim: vault balance should NOT change (claims only update transferred_amount)
    submit_claim(&mut context, &participant_a, &channel_pda, 1, 2000)
        .await
        .unwrap();

    let vault_balance_after_claim = get_vault_balance(&mut context, &vault_pda).await;
    assert_eq!(
        vault_balance_after_claim, vault_balance,
        "Vault balance must not change after claim (claims only update transferred_amount, not vault)"
    );

    // After another claim from B: vault still unchanged
    submit_claim(&mut context, &participant_b, &channel_pda, 1, 1000)
        .await
        .unwrap();

    let vault_balance_after_claim_b = get_vault_balance(&mut context, &vault_pda).await;
    assert_eq!(
        vault_balance_after_claim_b, vault_balance,
        "Vault balance unchanged after B's claim"
    );
}

// ============================================================================
// T-33.3-03: Balance conservation after settle (P0)
// AC 3: token_balance_a + token_balance_b == initial_deposit_a + initial_deposit_b
// ============================================================================

#[tokio::test]
async fn test_balance_conservation_after_settlement() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let initial_deposit_a: u64 = 15_000;
    let initial_deposit_b: u64 = 10_000;

    let (channel_pda, vault_pda, _token_mint, token_account_a, token_account_b) =
        setup_funded_channel(
            &mut context,
            &participant_a,
            &participant_b,
            &mint_authority,
            initial_deposit_a,
            initial_deposit_b,
        )
        .await;

    // Multiple claims from both participants
    submit_claim(&mut context, &participant_a, &channel_pda, 1, 5000)
        .await
        .unwrap();
    submit_claim(&mut context, &participant_a, &channel_pda, 2, 8000)
        .await
        .unwrap();
    submit_claim(&mut context, &participant_b, &channel_pda, 1, 3000)
        .await
        .unwrap();
    submit_claim(&mut context, &participant_b, &channel_pda, 2, 6000)
        .await
        .unwrap();

    // Close and settle
    let close_ix = build_close_channel_instruction(&participant_a.pubkey(), &channel_pda);
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[close_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a],
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    advance_clock_by_seconds(&mut context, (TEST_CHALLENGE_DURATION + 10) as i64).await;

    let settle_ix = build_settle_channel_instruction(
        &context.payer.pubkey(),
        &channel_pda,
        &vault_pda,
        &token_account_a,
        &token_account_b,
        &context.payer.pubkey(),
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[settle_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // final_balance_a = 15000 - 8000 + 6000 = 13000
    // final_balance_b = 10000 - 6000 + 8000 = 12000
    let a_account = context
        .banks_client
        .get_account(token_account_a)
        .await
        .unwrap()
        .unwrap();
    let final_balance_a = read_token_balance(&a_account.data);

    let b_account = context
        .banks_client
        .get_account(token_account_b)
        .await
        .unwrap()
        .unwrap();
    let final_balance_b = read_token_balance(&b_account.data);

    assert_eq!(
        final_balance_a, 13000,
        "A: deposit_a(15000) - transferred_a(8000) + transferred_b(6000)"
    );
    assert_eq!(
        final_balance_b, 12000,
        "B: deposit_b(10000) - transferred_b(6000) + transferred_a(8000)"
    );

    // Conservation invariant
    assert_eq!(
        final_balance_a + final_balance_b,
        initial_deposit_a + initial_deposit_b,
        "Total tokens must be conserved: final_a + final_b == deposit_a + deposit_b"
    );
}

// ============================================================================
// T-33.3-03b: Balance conservation with zero transferred amounts (P0)
// ============================================================================

#[tokio::test]
async fn test_balance_conservation_with_no_claims() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let initial_deposit_a: u64 = 7_500;
    let initial_deposit_b: u64 = 2_500;

    let (channel_pda, vault_pda, _token_mint, token_account_a, token_account_b) =
        setup_funded_channel(
            &mut context,
            &participant_a,
            &participant_b,
            &mint_authority,
            initial_deposit_a,
            initial_deposit_b,
        )
        .await;

    // No claims — close and settle directly
    let close_ix = build_close_channel_instruction(&participant_a.pubkey(), &channel_pda);
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[close_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a],
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    advance_clock_by_seconds(&mut context, (TEST_CHALLENGE_DURATION + 10) as i64).await;

    let settle_ix = build_settle_channel_instruction(
        &context.payer.pubkey(),
        &channel_pda,
        &vault_pda,
        &token_account_a,
        &token_account_b,
        &context.payer.pubkey(),
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[settle_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Each participant gets their deposit back exactly
    let a_account = context
        .banks_client
        .get_account(token_account_a)
        .await
        .unwrap()
        .unwrap();
    let final_balance_a = read_token_balance(&a_account.data);

    let b_account = context
        .banks_client
        .get_account(token_account_b)
        .await
        .unwrap()
        .unwrap();
    let final_balance_b = read_token_balance(&b_account.data);

    assert_eq!(
        final_balance_a, initial_deposit_a,
        "A should get deposit back exactly"
    );
    assert_eq!(
        final_balance_b, initial_deposit_b,
        "B should get deposit back exactly"
    );

    assert_eq!(
        final_balance_a + final_balance_b,
        initial_deposit_a + initial_deposit_b,
        "Conservation with no claims"
    );
}
