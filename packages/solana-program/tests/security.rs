// Security Tests for Story 33.3: Solana Payment Channel Program
//
// Tests cover nonce replay attacks, challenge period timing enforcement,
// PDA derivation ordering, overflow protection, and all security edge cases.
//
// Test IDs: T-33.3-04, T-33.3-05, T-33.3-06, T-33.3-09, T-33.3-10
//
// Test framework: solana-program-test (BanksClient, in-process)
// Runner: cargo test-sbf

use solana_program_test::*;
use solana_sdk::{
    account::Account as SolanaAccount,
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
const NONCE_A_OFFSET: usize = 136;
const STATE_FIELD_OFFSET: usize = 160;
const CLOSE_TIMESTAMP_OFFSET: usize = 161;

const STATE_OPENED: u8 = 0;
const STATE_CLOSED: u8 = 1;

// ============================================================================
// Test Helpers (duplicated for test isolation)
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

fn build_claim_instruction(
    claimer: &Pubkey,
    channel_pda: &Pubkey,
    nonce: u64,
    transferred_amount: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&[0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    data.extend_from_slice(&nonce.to_le_bytes());
    data.extend_from_slice(&transferred_amount.to_le_bytes());

    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*claimer, true),
            AccountMeta::new(*channel_pda, false),
            AccountMeta::new_readonly(sysvar::instructions::id(), false),
        ],
        data,
    }
}

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

fn to_dalek_keypair(keypair: &Keypair) -> ed25519_dalek::Keypair {
    ed25519_dalek::Keypair::from_bytes(&keypair.to_bytes()).unwrap()
}

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
    let claim_ix =
        build_claim_instruction(&claimer.pubkey(), channel_pda, nonce, transferred_amount);

    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ed25519_ix, claim_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, claimer],
        recent,
    );
    context.banks_client.process_transaction(tx).await
}

fn read_u64_at(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

/// Set the clock to a specific unix timestamp (absolute).
async fn set_clock_to_timestamp(context: &mut ProgramTestContext, timestamp: i64) {
    let current_clock = context.banks_client.get_sysvar::<Clock>().await.unwrap();
    let mut new_clock = current_clock.clone();
    let delta = timestamp - new_clock.unix_timestamp;
    new_clock.unix_timestamp = timestamp;
    if delta > 0 {
        new_clock.slot += (delta as u64) * 2;
    } else {
        // Cannot go backward in slots, but we can keep the same slot
        new_clock.slot += 1;
    }
    context.set_sysvar(&new_clock);
    context.warp_to_slot(new_clock.slot).unwrap();
}

// ============================================================================
// T-33.3-04: Nonce replay attack across multiple claims (P0)
// AC 4: Nonce replay is rejected across a sequence of claims
// ============================================================================

#[tokio::test]
async fn test_nonce_replay_attack_across_multiple_claims() {
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

    // Submit claims with nonces 1, 2, 3 successfully
    submit_claim(&mut context, &participant_a, &channel_pda, 1, 1000)
        .await
        .unwrap();
    submit_claim(&mut context, &participant_a, &channel_pda, 2, 2000)
        .await
        .unwrap();
    submit_claim(&mut context, &participant_a, &channel_pda, 3, 3000)
        .await
        .unwrap();

    // Replay nonce 2 — must fail with NonceNotMonotonic (error code 6)
    let result = submit_claim(&mut context, &participant_a, &channel_pda, 2, 4000).await;
    assert!(
        result.is_err(),
        "Replaying nonce 2 after nonces 1,2,3 should fail"
    );
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(
        err_str.contains("Custom(6)") || err_str.contains("NonceNotMonotonic"),
        "Expected NonceNotMonotonic error (Custom(6)), got: {}",
        err_str
    );

    // Also replay nonce 1 — must fail
    let result = submit_claim(&mut context, &participant_a, &channel_pda, 1, 5000).await;
    assert!(result.is_err(), "Replaying nonce 1 should fail");

    // Replay nonce 3 (current) — must also fail (not strictly greater)
    let result = submit_claim(&mut context, &participant_a, &channel_pda, 3, 5000).await;
    assert!(result.is_err(), "Replaying current nonce 3 should fail");

    // Nonce 4 should succeed (strictly greater)
    submit_claim(&mut context, &participant_a, &channel_pda, 4, 4000)
        .await
        .unwrap();

    // Verify final state
    let account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read_u64_at(&account.data, NONCE_A_OFFSET), 4);
    assert_eq!(
        read_u64_at(&account.data, TRANSFERRED_AMOUNT_A_OFFSET),
        4000
    );
}

// ============================================================================
// T-33.3-05: Challenge period timing boundary enforcement (P0)
// AC 5: Settlement timing boundary is enforced precisely
// ============================================================================

#[tokio::test]
async fn test_challenge_period_timing_boundary() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, token_mint, _ta_a, _ta_b) = setup_funded_channel(
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

    // Read the close_timestamp
    let channel_account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .unwrap();
    let close_timestamp = i64::from_le_bytes(
        channel_account.data[CLOSE_TIMESTAMP_OFFSET..CLOSE_TIMESTAMP_OFFSET + 8]
            .try_into()
            .unwrap(),
    );

    // Create token accounts for settlement
    let a_token_account = create_and_fund_token_account(
        &mut context,
        &token_mint,
        &participant_a.pubkey(),
        &mint_authority,
        0,
    )
    .await;
    let b_token_account = create_and_fund_token_account(
        &mut context,
        &token_mint,
        &participant_b.pubkey(),
        &mint_authority,
        0,
    )
    .await;

    // Attempt settle at close_timestamp + 59 (1 second before deadline) — should FAIL
    set_clock_to_timestamp(
        &mut context,
        close_timestamp + TEST_CHALLENGE_DURATION as i64 - 1,
    )
    .await;

    let settle_ix = build_settle_channel_instruction(
        &context.payer.pubkey(),
        &channel_pda,
        &vault_pda,
        &a_token_account,
        &b_token_account,
        &context.payer.pubkey(),
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[settle_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        recent,
    );
    let result = context.banks_client.process_transaction(tx).await;
    assert!(
        result.is_err(),
        "Settle at close_timestamp + 59 should fail (challenge not expired)"
    );
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(
        err_str.contains("Custom(3)") || err_str.contains("ChannelChallengeNotExpired"),
        "Expected ChannelChallengeNotExpired error, got: {}",
        err_str
    );

    // Attempt settle at close_timestamp + 60 (exactly at deadline) — should SUCCEED
    set_clock_to_timestamp(
        &mut context,
        close_timestamp + TEST_CHALLENGE_DURATION as i64,
    )
    .await;

    let settle_ix = build_settle_channel_instruction(
        &context.payer.pubkey(),
        &channel_pda,
        &vault_pda,
        &a_token_account,
        &b_token_account,
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

    // Verify channel is settled (account closed)
    let channel_account = context.banks_client.get_account(channel_pda).await.unwrap();
    assert!(
        channel_account.is_none(),
        "Channel should be closed after settlement at exact deadline"
    );
}

// ============================================================================
// T-33.3-06: PDA derivation with swapped participants (P0)
// AC 6: PDA derivation is order-independent
// ============================================================================

#[tokio::test]
async fn test_pda_derivation_swapped_participants_same_address() {
    let participant_a = Keypair::new();
    let participant_b = Keypair::new();
    let token_mint = Pubkey::new_unique();

    let (pda_ab, bump_ab) = derive_channel_pda(
        &participant_a.pubkey(),
        &participant_b.pubkey(),
        &token_mint,
        &PROGRAM_ID,
    );
    let (pda_ba, bump_ba) = derive_channel_pda(
        &participant_b.pubkey(),
        &participant_a.pubkey(),
        &token_mint,
        &PROGRAM_ID,
    );

    assert_eq!(
        pda_ab, pda_ba,
        "PDA must be the same regardless of participant ordering"
    );
    assert_eq!(
        bump_ab, bump_ba,
        "Bump must be the same regardless of participant ordering"
    );

    // Verify lexicographic sorting is applied
    let (min, max) = if participant_a.pubkey() < participant_b.pubkey() {
        (participant_a.pubkey(), participant_b.pubkey())
    } else {
        (participant_b.pubkey(), participant_a.pubkey())
    };

    let (pda_sorted, _) = Pubkey::find_program_address(
        &[b"channel", min.as_ref(), max.as_ref(), token_mint.as_ref()],
        &PROGRAM_ID,
    );

    assert_eq!(
        pda_ab, pda_sorted,
        "PDA should match direct derivation with sorted participants"
    );
}

// ============================================================================
// T-33.3-06b: PDA derivation with multiple different token mints
// ============================================================================

#[tokio::test]
async fn test_pda_derivation_different_mints_produce_different_pdas() {
    let participant_a = Keypair::new();
    let participant_b = Keypair::new();
    let mint1 = Pubkey::new_unique();
    let mint2 = Pubkey::new_unique();

    let (pda1, _) = derive_channel_pda(
        &participant_a.pubkey(),
        &participant_b.pubkey(),
        &mint1,
        &PROGRAM_ID,
    );
    let (pda2, _) = derive_channel_pda(
        &participant_a.pubkey(),
        &participant_b.pubkey(),
        &mint2,
        &PROGRAM_ID,
    );

    assert_ne!(pda1, pda2, "Different mints should produce different PDAs");
}

// ============================================================================
// T-33.3-09: Overflow protection — large deposits accumulate safely (P1)
// AC 9: ArithmeticOverflow defense-in-depth
//
// Note: The overflow check in process_deposit uses `checked_add` on deposit_a/deposit_b.
// Since SPL Token mint supply is capped at u64::MAX, it is not possible to trigger
// the on-chain overflow through normal token operations (the mint_to or transfer would
// fail first). This test verifies that large deposits near practical limits work
// correctly and that the checked arithmetic does not cause false rejections.
//
// The overflow protection is defense-in-depth against future program changes or
// alternative deposit paths that might bypass SPL Token supply constraints.
// ============================================================================

#[tokio::test]
async fn test_large_deposits_accumulate_correctly() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, token_mint, _ta_a, _ta_b) = setup_funded_channel(
        &mut context,
        &participant_a,
        &participant_b,
        &mint_authority,
        0,
        0,
    )
    .await;

    // Multiple deposits from A that accumulate to a large total
    let deposit_amount: u64 = 1_000_000_000; // 1 billion
    for i in 0..3u64 {
        let token_account = create_and_fund_token_account(
            &mut context,
            &token_mint,
            &participant_a.pubkey(),
            &mint_authority,
            deposit_amount,
        )
        .await;

        let ix = build_deposit_instruction(
            &participant_a.pubkey(),
            &token_account,
            &vault_pda,
            &channel_pda,
            deposit_amount,
        );
        let recent = context.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&context.payer.pubkey()),
            &[&context.payer, &participant_a],
            recent,
        );
        context.banks_client.process_transaction(tx).await.unwrap();

        // Verify the accumulation is correct
        let channel_account = context
            .banks_client
            .get_account(channel_pda)
            .await
            .unwrap()
            .expect("Channel should exist");
        let stored_deposit_a = read_u64_at(&channel_account.data, DEPOSIT_A_OFFSET);
        assert_eq!(
            stored_deposit_a,
            deposit_amount * (i + 1),
            "deposit_a should accumulate correctly after {} deposits",
            i + 1
        );
    }

    // Verify final state: deposit_a = 3 billion, deposit_b = 0
    let channel_account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        read_u64_at(&channel_account.data, DEPOSIT_A_OFFSET),
        3_000_000_000
    );
    assert_eq!(read_u64_at(&channel_account.data, DEPOSIT_B_OFFSET), 0);
    assert_eq!(channel_account.data[STATE_FIELD_OFFSET], STATE_OPENED);
}

// ============================================================================
// T-33.3-09b: Overflow protection — deposits summing past u64::MAX (P1)
// AC 9: ArithmeticOverflow error code 10 when deposit_a + amount > u64::MAX
//
// Strategy: Initialize a channel with a small deposit, then directly manipulate
// the channel PDA account data to set deposit_a near u64::MAX. A subsequent
// legitimate deposit triggers the checked_add overflow in process_deposit.
// This bypasses the SPL Token supply cap limitation that would otherwise prevent
// minting u64::MAX tokens, allowing us to exercise the on-chain overflow guard.
// ============================================================================

#[tokio::test]
async fn test_deposit_overflow_past_u64_max() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    // Set up channel with a small initial deposit so SPL Token state is valid
    let (channel_pda, vault_pda, token_mint, _ta_a, _ta_b) = setup_funded_channel(
        &mut context,
        &participant_a,
        &participant_b,
        &mint_authority,
        1_000, // participant A deposits 1000
        0,
    )
    .await;

    // Read current channel account and manipulate deposit_a to near u64::MAX
    let channel_account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .expect("Channel should exist");

    let mut manipulated_data = channel_account.data.clone();
    // Set deposit_a to u64::MAX - 500 (so adding 1000 will overflow)
    let overflow_deposit: u64 = u64::MAX - 500;
    manipulated_data[DEPOSIT_A_OFFSET..DEPOSIT_A_OFFSET + 8]
        .copy_from_slice(&overflow_deposit.to_le_bytes());

    // Write the manipulated account back
    context.set_account(
        &channel_pda,
        &SolanaAccount {
            lamports: channel_account.lamports,
            data: manipulated_data,
            owner: channel_account.owner,
            executable: channel_account.executable,
            rent_epoch: channel_account.rent_epoch,
        }
        .into(),
    );

    // Verify manipulation took effect
    let verify_account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        read_u64_at(&verify_account.data, DEPOSIT_A_OFFSET),
        overflow_deposit,
        "deposit_a should be manipulated to u64::MAX - 500"
    );

    // Create a new token account with 1000 tokens for participant A
    let new_token_account = create_and_fund_token_account(
        &mut context,
        &token_mint,
        &participant_a.pubkey(),
        &mint_authority,
        1_000,
    )
    .await;

    // Attempt deposit of 1000 — checked_add(u64::MAX - 500, 1000) overflows
    let ix = build_deposit_instruction(
        &participant_a.pubkey(),
        &new_token_account,
        &vault_pda,
        &channel_pda,
        1_000,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a],
        recent,
    );

    let result = context.banks_client.process_transaction(tx).await;
    assert!(
        result.is_err(),
        "Deposit causing u64 overflow should be rejected"
    );
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(
        err_str.contains("Custom(10)") || err_str.contains("ArithmeticOverflow"),
        "Expected ArithmeticOverflow error (Custom(10)), got: {}",
        err_str
    );

    // Verify no state corruption — deposit_a should remain unchanged
    let final_account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .expect("Channel should still exist after failed deposit");
    assert_eq!(
        read_u64_at(&final_account.data, DEPOSIT_A_OFFSET),
        overflow_deposit,
        "deposit_a should not be corrupted after overflow rejection"
    );
    assert_eq!(
        final_account.data[STATE_FIELD_OFFSET],
        STATE_OPENED,
        "Channel should remain in Opened state after overflow rejection"
    );
}

// ============================================================================
// T-33.3-10a: Invalid signature rejected (P0)
// AC 10: InvalidSignature error for bad Ed25519 signatures
// ============================================================================

#[tokio::test]
async fn test_invalid_signature_security_edge_case() {
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

    // Sign a WRONG message (different transferred_amount in the signed message)
    let wrong_message = build_balance_proof_message(&channel_pda, 1, 9999);
    let dalek_keypair = to_dalek_keypair(&participant_a);
    let ed25519_ix = new_ed25519_instruction(&dalek_keypair, &wrong_message);

    // But claim instruction has transferred_amount = 5000
    let claim_ix = build_claim_instruction(&participant_a.pubkey(), &channel_pda, 1, 5000);

    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ed25519_ix, claim_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a],
        recent,
    );
    let result = context.banks_client.process_transaction(tx).await;
    assert!(result.is_err(), "Mismatched signature should be rejected");
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(
        err_str.contains("Custom(8)") || err_str.contains("InvalidSignature"),
        "Expected InvalidSignature error (Custom(8)), got: {}",
        err_str
    );
}

// ============================================================================
// T-33.3-10b: Unauthorized signer rejected (P0)
// AC 10: UnauthorizedSigner error for non-participant signers
// ============================================================================

#[tokio::test]
async fn test_unauthorized_signer_security_edge_case() {
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

    // Outsider signs a valid balance proof but is not a participant
    let message = build_balance_proof_message(&channel_pda, 1, 5000);
    let dalek_outsider = to_dalek_keypair(&outsider);
    let ed25519_ix = new_ed25519_instruction(&dalek_outsider, &message);
    let claim_ix = build_claim_instruction(&outsider.pubkey(), &channel_pda, 1, 5000);

    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ed25519_ix, claim_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, &outsider],
        recent,
    );
    let result = context.banks_client.process_transaction(tx).await;
    assert!(result.is_err(), "Non-participant signer should be rejected");
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(
        err_str.contains("Custom(9)") || err_str.contains("UnauthorizedSigner"),
        "Expected UnauthorizedSigner error (Custom(9)), got: {}",
        err_str
    );
}

// ============================================================================
// T-33.3-10c: Decreased transferred_amount rejected (P0)
// AC 10: TransferredAmountDecreased error
// ============================================================================

#[tokio::test]
async fn test_decreased_transferred_amount_security_edge_case() {
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

    // Second claim with decreased amount = 3000 — must fail
    let result = submit_claim(&mut context, &participant_a, &channel_pda, 2, 3000).await;
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
// T-33.3-S01: Deposit after close rejected
// ============================================================================

#[tokio::test]
async fn test_deposit_after_close_rejected() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    let (channel_pda, vault_pda, token_mint, _ta_a, _ta_b) = setup_funded_channel(
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

    // Verify closed
    let account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(account.data[STATE_FIELD_OFFSET], STATE_CLOSED);

    // Attempt deposit on closed channel
    let new_token_account = create_and_fund_token_account(
        &mut context,
        &token_mint,
        &participant_a.pubkey(),
        &mint_authority,
        1000,
    )
    .await;
    let ix = build_deposit_instruction(
        &participant_a.pubkey(),
        &new_token_account,
        &vault_pda,
        &channel_pda,
        1000,
    );
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a],
        recent,
    );
    let result = context.banks_client.process_transaction(tx).await;
    assert!(result.is_err(), "Deposit after close should fail");
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(
        err_str.contains("Custom(1)") || err_str.contains("ChannelNotOpened"),
        "Expected ChannelNotOpened error (Custom(1)), got: {}",
        err_str
    );
}

// ============================================================================
// T-33.3-S02: Claim with wrong channel PDA
// ============================================================================

#[tokio::test]
async fn test_claim_with_wrong_channel_pda() {
    let mut context = program_test().start_with_context().await;
    let (participant_a, participant_b) = sorted_participants();
    let mint_authority = Keypair::new();

    // Set up channel 1
    let (channel_pda_1, _vault_pda_1, _token_mint_1, _ta_a_1, _ta_b_1) = setup_funded_channel(
        &mut context,
        &participant_a,
        &participant_b,
        &mint_authority,
        10_000,
        10_000,
    )
    .await;

    // Set up channel 2 with different participants
    let (participant_c, participant_d) = sorted_participants();
    let (channel_pda_2, _vault_pda_2, _token_mint_2, _ta_c, _ta_d) = setup_funded_channel(
        &mut context,
        &participant_c,
        &participant_d,
        &mint_authority,
        10_000,
        10_000,
    )
    .await;

    // Try to claim on channel 2's PDA using participant A's signature
    // The balance proof references channel 2's PDA but participant A is not in channel 2
    let message = build_balance_proof_message(&channel_pda_2, 1, 5000);
    let dalek_keypair = to_dalek_keypair(&participant_a);
    let ed25519_ix = new_ed25519_instruction(&dalek_keypair, &message);
    let claim_ix = build_claim_instruction(&participant_a.pubkey(), &channel_pda_2, 1, 5000);

    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ed25519_ix, claim_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, &participant_a],
        recent,
    );
    let result = context.banks_client.process_transaction(tx).await;
    assert!(
        result.is_err(),
        "Claim on wrong channel PDA should be rejected"
    );
    // Should fail with UnauthorizedSigner since participant_a is not in channel 2
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(
        err_str.contains("Custom(9)") || err_str.contains("UnauthorizedSigner"),
        "Expected UnauthorizedSigner error for wrong channel, got: {}",
        err_str
    );

    // Original channel should be unaffected
    let account = context
        .banks_client
        .get_account(channel_pda_1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(account.data[STATE_FIELD_OFFSET], STATE_OPENED);
    assert_eq!(read_u64_at(&account.data, NONCE_A_OFFSET), 0);
}
