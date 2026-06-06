// Performance Tests for Story 33.3: CU Profiling and Rent Economics
//
// Tests validate compute unit consumption stays within budget and
// that all accounts are rent-exempt.
//
// Test IDs: T-33.3-07, T-33.3-08
//
// Test framework: solana-program-test (BanksClient, in-process)
// Runner: cargo test-sbf

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

/// Program ID for the payment channel program.
const PROGRAM_ID: Pubkey = solana_sdk::pubkey!("598iSn5tfXsLcTPKj97SzKiCLVbKf7okNY4AEjgpLg2W");

/// Challenge duration used in tests (60 seconds).
const TEST_CHALLENGE_DURATION: u64 = 60;

/// Channel account size (178 bytes, from state.rs).
const CHANNEL_ACCOUNT_SIZE: usize = 178;

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

// ============================================================================
// T-33.3-07: claim_from_channel CU consumption under 50,000 (P1)
// AC 7: Compute unit profiling
// ============================================================================

#[tokio::test]
async fn test_claim_from_channel_cu_under_budget() {
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

    // Build the claim transaction for simulation
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
    let tx = Transaction::new_signed_with_payer(
        &[ed25519_ix, claim_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        recent,
    );

    // Use simulate_transaction to get CU consumption
    let simulation = context.banks_client.simulate_transaction(tx).await.unwrap();

    // The simulation result contains compute units consumed
    let cu_consumed = simulation
        .simulation_details
        .expect("Simulation should return details")
        .units_consumed;

    // Ed25519 precompile uses ~2,280 CU; our program logic should use <10,000 CU
    // Combined should be well under 50,000
    assert!(
        cu_consumed < 50_000,
        "claim_from_channel CU consumption ({}) should be under 50,000",
        cu_consumed
    );

    // Log CU for profiling visibility
    eprintln!(
        "T-33.3-07: claim_from_channel consumed {} CU (limit: 50,000)",
        cu_consumed
    );
}

// ============================================================================
// T-33.3-07b: initialize_channel CU consumption baseline (P1)
// ============================================================================

#[tokio::test]
async fn test_initialize_channel_cu_baseline() {
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

    let simulation = context.banks_client.simulate_transaction(tx).await.unwrap();

    let cu_consumed = simulation
        .simulation_details
        .expect("Simulation should return details")
        .units_consumed;

    // initialize_channel creates 2 accounts (channel PDA + vault) so it uses more CU
    // but should still be well within the 200K default budget
    assert!(
        cu_consumed < 200_000,
        "initialize_channel CU consumption ({}) should be under 200,000",
        cu_consumed
    );

    eprintln!(
        "T-33.3-07b: initialize_channel consumed {} CU (limit: 200,000)",
        cu_consumed
    );
}

// ============================================================================
// T-33.3-07c: deposit CU consumption baseline (P1)
// ============================================================================

#[tokio::test]
async fn test_deposit_cu_baseline() {
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

    // Initialize channel first
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

    // Create funded token account
    let token_account_a = create_and_fund_token_account(
        &mut context,
        &token_mint,
        &participant_a.pubkey(),
        &mint_authority,
        5000,
    )
    .await;

    // Build deposit transaction for simulation
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

    let simulation = context.banks_client.simulate_transaction(tx).await.unwrap();

    let cu_consumed = simulation
        .simulation_details
        .expect("Simulation should return details")
        .units_consumed;

    assert!(
        cu_consumed < 50_000,
        "deposit CU consumption ({}) should be under 50,000",
        cu_consumed
    );

    eprintln!(
        "T-33.3-07c: deposit consumed {} CU (limit: 50,000)",
        cu_consumed
    );
}

// ============================================================================
// T-33.3-08: Rent economics — accounts are rent-exempt (P1)
// AC 8: Channel PDA and vault are rent-exempt
// ============================================================================

#[tokio::test]
async fn test_channel_and_vault_are_rent_exempt() {
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

    // Get rent sysvar
    let rent = context.banks_client.get_rent().await.unwrap();

    // Verify channel PDA is rent-exempt
    let channel_account = context
        .banks_client
        .get_account(channel_pda)
        .await
        .unwrap()
        .expect("Channel PDA should exist");

    let channel_min_rent = rent.minimum_balance(CHANNEL_ACCOUNT_SIZE);
    assert!(
        channel_account.lamports >= channel_min_rent,
        "Channel PDA lamports ({}) should be >= rent-exempt minimum ({}) for {} bytes",
        channel_account.lamports,
        channel_min_rent,
        CHANNEL_ACCOUNT_SIZE
    );
    assert!(
        rent.is_exempt(channel_account.lamports, channel_account.data.len()),
        "Channel PDA should be rent-exempt"
    );

    // Verify vault token account is rent-exempt
    let vault_account = context
        .banks_client
        .get_account(vault_pda)
        .await
        .unwrap()
        .expect("Vault PDA should exist");

    let vault_min_rent = rent.minimum_balance(spl_token::state::Account::LEN);
    assert!(
        vault_account.lamports >= vault_min_rent,
        "Vault PDA lamports ({}) should be >= rent-exempt minimum ({}) for {} bytes",
        vault_account.lamports,
        vault_min_rent,
        spl_token::state::Account::LEN
    );
    assert!(
        rent.is_exempt(vault_account.lamports, vault_account.data.len()),
        "Vault token account should be rent-exempt"
    );

    // Log rent economics for visibility
    eprintln!(
        "T-33.3-08: Channel PDA ({} bytes): {} lamports (min: {})",
        CHANNEL_ACCOUNT_SIZE, channel_account.lamports, channel_min_rent
    );
    eprintln!(
        "T-33.3-08: Vault ({} bytes): {} lamports (min: {})",
        spl_token::state::Account::LEN,
        vault_account.lamports,
        vault_min_rent
    );
}
