// Claim Verification Tests for Story 33.2: Solana Payment Channel Program — Claim Verification
//
// GREEN PHASE: All tests should pass with the implemented claim_from_channel handler.
//
// Test framework: solana-program-test (BanksClient, in-process)
// Runner: cargo test-sbf
//
// Test IDs reference: test-design-epic-33.md (T-33.2-01 through T-33.2-12)

use solana_program_test::*;
use solana_sdk::{
    ed25519_instruction::new_ed25519_instruction,
    instruction::{AccountMeta, Instruction},
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program, sysvar,
    transaction::Transaction,
};

/// Program ID for the payment channel program (must match lifecycle.rs and lib.rs).
const PROGRAM_ID: Pubkey = solana_sdk::pubkey!("598iSn5tfXsLcTPKj97SzKiCLVbKf7okNY4AEjgpLg2W");

// ============================================================================
// Byte offsets matching the program's state.rs layout
// ============================================================================
const TRANSFERRED_AMOUNT_A_OFFSET: usize = 120;
const TRANSFERRED_AMOUNT_B_OFFSET: usize = 128;
const NONCE_A_OFFSET: usize = 136;
const NONCE_B_OFFSET: usize = 144;
const STATE_FIELD_OFFSET: usize = 160;

const STATE_OPENED: u8 = 0;
const STATE_CLOSED: u8 = 1;

/// Challenge duration used in tests (60 seconds).
const TEST_CHALLENGE_DURATION: u64 = 60;

// ============================================================================
// Test Helpers (duplicated from lifecycle.rs for test isolation)
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

/// Build a claim_from_channel instruction.
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

/// Build a balance proof message: channel_pda (32) || nonce (8 LE) || transferred_amount (8 LE)
fn build_balance_proof_message(
    channel_pda: &Pubkey,
    nonce: u64,
    transferred_amount: u64,
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(48);
    msg.extend_from_slice(channel_pda.as_ref());
    msg.extend_from_slice(&nonce.to_le_bytes());
    msg.extend_from_slice(&transferred_amount.to_le_bytes());
    msg
}

/// Convert a solana_sdk::Keypair to an ed25519_dalek::Keypair for use with new_ed25519_instruction.
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
    let message = build_balance_proof_message(channel_pda, nonce, transferred_amount);
    let dalek_keypair = to_dalek_keypair(claimer);
    let ed25519_ix = new_ed25519_instruction(&dalek_keypair, &message);
    // The claimer (participant) authorizes via the precompile only; the
    // fee-payer (context.payer) is the sole tx signer. This exercises the #99
    // unilateral-redemption path where the participant does not sign the tx.
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

/// Advances the clock sysvar by the given number of seconds.
async fn advance_clock_by_seconds(context: &mut ProgramTestContext, seconds: i64) {
    let current_clock = context
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    let mut new_clock = current_clock.clone();
    new_clock.unix_timestamp += seconds;
    new_clock.slot += (seconds as u64) * 2;
    context.set_sysvar(&new_clock);
    context.warp_to_slot(new_clock.slot).unwrap();
}

// ============================================================================
// T-33.2-01: Valid claim updates nonce and transferred_amount (P0)
// ============================================================================

#[tokio::test]
async fn test_valid_claim_updates_channel_state() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, _vault_pda, _token_mint, _ta_a, _ta_b) = setup_funded_channel(
        &mut context,
        &participant_a,
        &participant_b,
        &mint_authority,
        10_000,
        10_000,
    )
    .await;

    // Submit a valid claim from participant A
    submit_claim(&mut context, &participant_a, &channel_pda, 1, 5000)
        .await
        .unwrap();

    // Verify channel state
    let account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .expect("Channel should exist");
    let data = &account.data;

    assert_eq!(read_u64_at(data, NONCE_A_OFFSET), 1);
    assert_eq!(read_u64_at(data, TRANSFERRED_AMOUNT_A_OFFSET), 5000);
    // B's fields should be unchanged
    assert_eq!(read_u64_at(data, NONCE_B_OFFSET), 0);
    assert_eq!(read_u64_at(data, TRANSFERRED_AMOUNT_B_OFFSET), 0);
    // Channel should remain Opened
    assert_eq!(data[STATE_FIELD_OFFSET], STATE_OPENED);
}

// ============================================================================
// T-33.2-02: Replayed nonce fails with NonceNotMonotonic (P0)
// ============================================================================

#[tokio::test]
async fn test_replayed_nonce_rejected() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, _vault_pda, _token_mint, _ta_a, _ta_b) = setup_funded_channel(
        &mut context,
        &participant_a,
        &participant_b,
        &mint_authority,
        10_000,
        10_000,
    )
    .await;

    // First claim succeeds
    submit_claim(&mut context, &participant_a, &channel_pda, 5, 1000)
        .await
        .unwrap();

    // Replay same nonce = 5 should fail
    let result = submit_claim(&mut context, &participant_a, &channel_pda, 5, 2000).await;
    assert!(result.is_err(), "Replayed nonce should be rejected");
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(
        err_str.contains("Custom(6)") || err_str.contains("NonceNotMonotonic"),
        "Expected NonceNotMonotonic error (Custom(6)), got: {}",
        err_str
    );
}

// ============================================================================
// T-33.2-03: Stale nonce fails with NonceNotMonotonic (P0)
// ============================================================================

#[tokio::test]
async fn test_stale_nonce_rejected() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, _vault_pda, _token_mint, _ta_a, _ta_b) = setup_funded_channel(
        &mut context,
        &participant_a,
        &participant_b,
        &mint_authority,
        10_000,
        10_000,
    )
    .await;

    // First claim with nonce = 5
    submit_claim(&mut context, &participant_a, &channel_pda, 5, 1000)
        .await
        .unwrap();

    // Stale nonce = 4 should fail
    let result = submit_claim(&mut context, &participant_a, &channel_pda, 4, 2000).await;
    assert!(result.is_err(), "Stale nonce should be rejected");
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(
        err_str.contains("Custom(6)") || err_str.contains("NonceNotMonotonic"),
        "Expected NonceNotMonotonic error (Custom(6)), got: {}",
        err_str
    );
}

// ============================================================================
// T-33.2-04: Invalid signature fails with InvalidSignature (P0)
// ============================================================================

#[tokio::test]
async fn test_invalid_signature_rejected() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, _vault_pda, _token_mint, _ta_a, _ta_b) = setup_funded_channel(
        &mut context,
        &participant_a,
        &participant_b,
        &mint_authority,
        10_000,
        10_000,
    )
    .await;

    // Sign a WRONG message (different nonce in the signed message vs the instruction)
    let wrong_message = build_balance_proof_message(&channel_pda, 999, 5000);
    let dalek_keypair = to_dalek_keypair(&participant_a);
    let ed25519_ix = new_ed25519_instruction(&dalek_keypair, &wrong_message);

    // But claim instruction has nonce = 1
    let claim_ix = build_claim_instruction(
        &context.payer.pubkey(),
        &participant_a.pubkey(),
        &channel_pda,
        1,
        5000,
    );

    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    // Per #99, the claiming participant (participant_a) is a non-signer at
    // index 1 and authorizes solely via the Ed25519 precompile; only the
    // fee-payer (context.payer) signs the redemption transaction.
    let tx = Transaction::new_signed_with_payer(
        &[ed25519_ix, claim_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        recent,
    );
    let result = context.banks_client.process_transaction(tx).await;
    assert!(
        result.is_err(),
        "Mismatched balance proof message should be rejected"
    );
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(
        err_str.contains("Custom(8)") || err_str.contains("InvalidSignature"),
        "Expected InvalidSignature error (Custom(8)), got: {}",
        err_str
    );
}

// ============================================================================
// T-33.2-05: Non-participant signer fails with UnauthorizedSigner (P0)
// ============================================================================

#[tokio::test]
async fn test_non_participant_signer_rejected() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();
    let outsider = Keypair::new();

    let (channel_pda, _vault_pda, _token_mint, _ta_a, _ta_b) = setup_funded_channel(
        &mut context,
        &participant_a,
        &participant_b,
        &mint_authority,
        10_000,
        10_000,
    )
    .await;

    // The outsider signs the balance proof but is not a channel participant
    let message = build_balance_proof_message(&channel_pda, 1, 5000);
    let dalek_outsider = to_dalek_keypair(&outsider);
    let ed25519_ix = new_ed25519_instruction(&dalek_outsider, &message);
    let claim_ix = build_claim_instruction(
        &context.payer.pubkey(),
        &outsider.pubkey(),
        &channel_pda,
        1,
        5000,
    );

    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ed25519_ix, claim_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        recent,
    );
    let result = context.banks_client.process_transaction(tx).await;
    assert!(
        result.is_err(),
        "Non-participant signer should be rejected with UnauthorizedSigner"
    );
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(
        err_str.contains("Custom(9)") || err_str.contains("UnauthorizedSigner"),
        "Expected UnauthorizedSigner error (Custom(9)), got: {}",
        err_str
    );
}

// ============================================================================
// T-33.2-06: Decreased transferred_amount fails (P0)
// ============================================================================

#[tokio::test]
async fn test_decreased_transferred_amount_rejected() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, _vault_pda, _token_mint, _ta_a, _ta_b) = setup_funded_channel(
        &mut context,
        &participant_a,
        &participant_b,
        &mint_authority,
        10_000,
        10_000,
    )
    .await;

    // First claim: transferred_amount = 5000
    submit_claim(&mut context, &participant_a, &channel_pda, 1, 5000)
        .await
        .unwrap();

    // Second claim with decreased amount = 4000 should fail
    let result = submit_claim(&mut context, &participant_a, &channel_pda, 2, 4000).await;
    assert!(
        result.is_err(),
        "Decreased transferred_amount should be rejected"
    );
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(
        err_str.contains("Custom(7)") || err_str.contains("TransferredAmountDecreased"),
        "Expected TransferredAmountDecreased error (Custom(7)), got: {}",
        err_str
    );
}

// ============================================================================
// T-33.2-07: Claim on closed channel succeeds (P0)
// ============================================================================

#[tokio::test]
async fn test_claim_on_closed_channel_succeeds() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, _vault_pda, _token_mint, _ta_a, _ta_b) = setup_funded_channel(
        &mut context,
        &participant_a,
        &participant_b,
        &mint_authority,
        10_000,
        10_000,
    )
    .await;

    // Close the channel
    let close_ix = build_close_channel_instruction(&participant_a.pubkey(), &channel_pda);
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[close_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a],
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Verify channel is Closed
    let account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(account.data[STATE_FIELD_OFFSET], STATE_CLOSED);

    // Claim should still succeed on closed channel
    submit_claim(&mut context, &participant_a, &channel_pda, 1, 3000)
        .await
        .unwrap();

    // Verify state was updated
    let account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read_u64_at(&account.data, NONCE_A_OFFSET), 1);
    assert_eq!(
        read_u64_at(&account.data, TRANSFERRED_AMOUNT_A_OFFSET),
        3000
    );
    // Channel should still be Closed
    assert_eq!(account.data[STATE_FIELD_OFFSET], STATE_CLOSED);
}

// ============================================================================
// T-33.2-08: Ed25519 precompile instruction missing fails (P1)
// ============================================================================

#[tokio::test]
async fn test_missing_ed25519_precompile_rejected() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, _vault_pda, _token_mint, _ta_a, _ta_b) = setup_funded_channel(
        &mut context,
        &participant_a,
        &participant_b,
        &mint_authority,
        10_000,
        10_000,
    )
    .await;

    // Submit claim WITHOUT Ed25519 precompile instruction
    let claim_ix = build_claim_instruction(
        &context.payer.pubkey(),
        &participant_a.pubkey(),
        &channel_pda,
        1,
        5000,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    // Per #99, the claiming participant (participant_a) is a non-signer at
    // index 1; only the fee-payer (context.payer) signs the transaction. This
    // tx deliberately omits the Ed25519 precompile to exercise rejection.
    let tx = Transaction::new_signed_with_payer(
        &[claim_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        recent,
    );
    let result = context.banks_client.process_transaction(tx).await;
    assert!(
        result.is_err(),
        "Missing Ed25519 precompile should be rejected"
    );
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(
        err_str.contains("Custom(8)") || err_str.contains("InvalidSignature"),
        "Expected InvalidSignature error (Custom(8)), got: {}",
        err_str
    );
}

// ============================================================================
// T-33.2-09: Ed25519 precompile at wrong index fails (P1)
// ============================================================================

#[tokio::test]
async fn test_ed25519_precompile_at_wrong_index_rejected() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, _vault_pda, _token_mint, _ta_a, _ta_b) = setup_funded_channel(
        &mut context,
        &participant_a,
        &participant_b,
        &mint_authority,
        10_000,
        10_000,
    )
    .await;

    // Put claim instruction FIRST, Ed25519 precompile SECOND (wrong order)
    let message = build_balance_proof_message(&channel_pda, 1, 5000);
    let dalek_keypair = to_dalek_keypair(&participant_a);
    let ed25519_ix = new_ed25519_instruction(&dalek_keypair, &message);
    let claim_ix = build_claim_instruction(
        &context.payer.pubkey(),
        &participant_a.pubkey(),
        &channel_pda,
        1,
        5000,
    );

    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    // Per #99, the claiming participant (participant_a) is a non-signer at
    // index 1; only the fee-payer (context.payer) signs the transaction. The
    // instructions are deliberately ordered with the precompile at the wrong
    // index to exercise rejection.
    let tx = Transaction::new_signed_with_payer(
        &[claim_ix, ed25519_ix], // Wrong order: claim at 0, ed25519 at 1
        Some(&context.payer.pubkey()),
        &[&context.payer],
        recent,
    );
    let result = context.banks_client.process_transaction(tx).await;
    assert!(
        result.is_err(),
        "Ed25519 precompile at wrong index should be rejected"
    );
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(
        err_str.contains("Custom(8)") || err_str.contains("InvalidSignature"),
        "Expected InvalidSignature error (Custom(8)), got: {}",
        err_str
    );
}

// ============================================================================
// T-33.2-10: Multiple sequential claims succeed (P1)
// ============================================================================

#[tokio::test]
async fn test_multiple_sequential_claims_succeed() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, _vault_pda, _token_mint, _ta_a, _ta_b) = setup_funded_channel(
        &mut context,
        &participant_a,
        &participant_b,
        &mint_authority,
        10_000,
        10_000,
    )
    .await;

    // Submit claims with nonces 1, 2, 3
    for i in 1..=3u64 {
        submit_claim(&mut context, &participant_a, &channel_pda, i, 1000 * i)
            .await
            .unwrap();
    }

    // Verify final state
    let account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read_u64_at(&account.data, NONCE_A_OFFSET), 3);
    assert_eq!(
        read_u64_at(&account.data, TRANSFERRED_AMOUNT_A_OFFSET),
        3000
    );
}

// ============================================================================
// T-33.2-11: Claim on settled channel fails (P1)
// ============================================================================

#[tokio::test]
async fn test_claim_on_settled_channel_fails() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, _token_mint, token_account_a, token_account_b) =
        setup_funded_channel(
            &mut context,
            &participant_a,
            &participant_b,
            &mint_authority,
            10_000,
            10_000,
        )
        .await;

    // Close the channel
    let close_ix = build_close_channel_instruction(&participant_a.pubkey(), &channel_pda);
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[close_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a],
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Advance clock past challenge period
    advance_clock_by_seconds(&mut context, (TEST_CHALLENGE_DURATION + 1) as i64).await;

    // Settle the channel
    let settle_ix = build_settle_channel_instruction(
        &participant_a.pubkey(),
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
        &[&context.payer, &participant_a],
        recent,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    // Verify channel account is closed (zeroed/reclaimed)
    let account = context.banks_client.get_account(channel_pda).await.unwrap();
    assert!(
        account.is_none() || account.unwrap().data.iter().all(|&b| b == 0),
        "Channel account should be zeroed after settlement"
    );

    // Attempt to claim on settled channel should fail
    let result = submit_claim(&mut context, &participant_a, &channel_pda, 1, 5000).await;
    assert!(
        result.is_err(),
        "Claim on settled channel should be rejected"
    );
}

// ============================================================================
// T-33.2-12: Balance proof message format is exactly 48 bytes (P0)
// ============================================================================

#[tokio::test]
async fn test_balance_proof_message_format() {
    let channel_pda = Pubkey::new_unique();
    let nonce: u64 = 42;
    let transferred_amount: u64 = 123456;

    let message = build_balance_proof_message(&channel_pda, nonce, transferred_amount);

    // Total size is 48 bytes
    assert_eq!(
        message.len(),
        48,
        "Balance proof message must be exactly 48 bytes"
    );

    // First 32 bytes are channel_pda
    assert_eq!(&message[0..32], channel_pda.as_ref());

    // Next 8 bytes are nonce (LE)
    assert_eq!(
        u64::from_le_bytes(message[32..40].try_into().unwrap()),
        nonce
    );

    // Next 8 bytes are transferred_amount (LE)
    assert_eq!(
        u64::from_le_bytes(message[40..48].try_into().unwrap()),
        transferred_amount
    );
}

// ============================================================================
// T-33.2-13: Claim from participant B updates B's fields (not A's)
// ============================================================================

#[tokio::test]
async fn test_claim_from_participant_b_updates_b_fields() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, _vault_pda, _token_mint, _ta_a, _ta_b) = setup_funded_channel(
        &mut context,
        &participant_a,
        &participant_b,
        &mint_authority,
        10_000,
        10_000,
    )
    .await;

    // Submit a claim from participant B
    submit_claim(&mut context, &participant_b, &channel_pda, 1, 7000)
        .await
        .unwrap();

    // Verify B's fields are updated
    let account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .unwrap();
    let data = &account.data;

    assert_eq!(read_u64_at(data, NONCE_B_OFFSET), 1);
    assert_eq!(read_u64_at(data, TRANSFERRED_AMOUNT_B_OFFSET), 7000);
    // A's fields should be unchanged
    assert_eq!(read_u64_at(data, NONCE_A_OFFSET), 0);
    assert_eq!(read_u64_at(data, TRANSFERRED_AMOUNT_A_OFFSET), 0);
}

// ============================================================================
// T-33.2-14: Third-party fee-payer redeems a participant's claim without the
// participant signing the transaction (#99 unilateral inbound-peer redemption).
// The participant authorizes (nonce, transferred_amount) solely via the Ed25519
// precompile; a distinct submitter (the connector) signs/pays for the tx.
// ============================================================================

#[tokio::test]
async fn test_third_party_fee_payer_redeems_without_participant_signature() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, _vault_pda, _token_mint, _ta_a, _ta_b) = setup_funded_channel(
        &mut context,
        &participant_a,
        &participant_b,
        &mint_authority,
        10_000,
        10_000,
    )
    .await;

    // A distinct submitter (the connector) that is NOT a channel participant and
    // is NOT the default test payer. Fund it so it can pay the transaction fee.
    let connector = Keypair::new();
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let fund_tx = Transaction::new_signed_with_payer(
        &[solana_sdk::system_instruction::transfer(
            &context.payer.pubkey(),
            &connector.pubkey(),
            1_000_000_000,
        )],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        recent,
    );
    context
        .banks_client
        .process_transaction(fund_tx)
        .await
        .unwrap();

    // Participant A signs the balance proof (the precompile authorization), but
    // does NOT sign the redemption transaction.
    let message = build_balance_proof_message(&channel_pda, 1, 5000);
    let dalek_a = to_dalek_keypair(&participant_a);
    let ed25519_ix = new_ed25519_instruction(&dalek_a, &message);
    let claim_ix = build_claim_instruction(
        &connector.pubkey(),
        &participant_a.pubkey(),
        &channel_pda,
        1,
        5000,
    );

    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    // Only the connector signs the tx; participant A is absent.
    let tx = Transaction::new_signed_with_payer(
        &[ed25519_ix, claim_ix],
        Some(&connector.pubkey()),
        &[&connector],
        recent,
    );
    context
        .banks_client
        .process_transaction(tx)
        .await
        .expect("Connector should redeem participant A's signed claim unilaterally");

    // Verify A's fields were credited from the precompile-authorized proof.
    let account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .unwrap();
    let data = &account.data;
    assert_eq!(read_u64_at(data, NONCE_A_OFFSET), 1);
    assert_eq!(read_u64_at(data, TRANSFERRED_AMOUNT_A_OFFSET), 5000);
}
