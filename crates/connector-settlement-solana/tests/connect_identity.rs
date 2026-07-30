//! Issue #630: `SolanaSettlementBackend::connect`'s fail-closed identity
//! checks. `deploy` and the contract suite already prove program-reachable
//! and mint-owned-by-SPL-Token (issue #567); these are the "fuller" checks
//! `connect`'s own doc deferred to this later issue -- the configured
//! `decimals` must agree with the mint's own `decimals` field (the same
//! `#564` rule `EvmSettlementBackend::connect` already enforces for its
//! ERC-20's `decimals()`), and the configured `program_id` must actually
//! behave like the deployed payment-channel program, not merely be
//! executable (`verify_program_identity`, this issue's review finding 2).

use std::str::FromStr;

use connector_settlement_solana::SolanaSettlementBackend;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signer;

use connector_settlement_solana::test_support::{
    fund, require_solana_test_validator, SolanaValidator, LOCAL_TEST_PROGRAM_ID,
};

/// A funded ed25519 seed [`SolanaSettlementBackend::connect`] can sign
/// transactions with -- `connect` itself submits one (`ensure_own_ata_exists`),
/// so the identity it binds to needs real lamports, exactly as a freshly
/// generated production signer would on a real cluster.
async fn funded_seed(rpc: &RpcClient, seed: [u8; 32]) -> [u8; 32] {
    let payer = solana_sdk::signer::keypair::keypair_from_seed(&seed).expect("derive keypair");
    fund(rpc, &payer.pubkey()).await;
    seed
}

#[tokio::test]
async fn connect_refuses_a_decimals_mismatch_naming_both_values() {
    if !require_solana_test_validator() {
        return;
    }

    let validator = SolanaValidator::spawn().await;
    let program_id = Pubkey::from_str(LOCAL_TEST_PROGRAM_ID).expect("valid local test program id");
    // `deploy` creates a fresh 6-decimal mint (see its own doc/body).
    let deployed = SolanaSettlementBackend::deploy(&validator.rpc_url, program_id)
        .await
        .expect("bind to the genesis-loaded payment-channel program");
    let token_mint = deployed.token_mint();

    let rpc =
        RpcClient::new_with_commitment(validator.rpc_url.clone(), CommitmentConfig::confirmed());
    let seed = funded_seed(&rpc, [3u8; 32]).await;

    let Err(error) =
        SolanaSettlementBackend::connect(&validator.rpc_url, &seed, program_id, token_mint, 9)
            .await
    else {
        panic!("a decimals the mint disagrees with must refuse to connect");
    };
    let message = error.to_string();
    assert!(
        message.contains("decimals is 9") && message.contains("decimals = 6"),
        "the failure must name both the configured and the on-chain decimals: {message}"
    );
}

#[tokio::test]
async fn connect_succeeds_when_decimals_agree() {
    if !require_solana_test_validator() {
        return;
    }

    let validator = SolanaValidator::spawn().await;
    let program_id = Pubkey::from_str(LOCAL_TEST_PROGRAM_ID).expect("valid local test program id");
    let deployed = SolanaSettlementBackend::deploy(&validator.rpc_url, program_id)
        .await
        .expect("bind to the genesis-loaded payment-channel program");
    let token_mint = deployed.token_mint();

    let rpc =
        RpcClient::new_with_commitment(validator.rpc_url.clone(), CommitmentConfig::confirmed());
    let seed = funded_seed(&rpc, [4u8; 32]).await;

    SolanaSettlementBackend::connect(&validator.rpc_url, &seed, program_id, token_mint, 6)
        .await
        .expect("decimals agree with the mint, connect should succeed");
}

/// Issue #630's review, finding 2: existing-and-executable is not
/// identity. A `program_id` naming a real, executable program that is not
/// the payment-channel program -- SPL Token itself here, executable on
/// every cluster including a fresh test validator -- must refuse to
/// connect, naming the configured program id, rather than pass the coarse
/// executability check and fail lazily at the first settle. The passing
/// twin is `connect_succeeds_when_decimals_agree` above: the same probe
/// runs there against the real program and lets connect through.
#[tokio::test]
async fn connect_refuses_a_program_id_naming_some_other_executable_program() {
    if !require_solana_test_validator() {
        return;
    }

    let validator = SolanaValidator::spawn().await;
    let program_id = Pubkey::from_str(LOCAL_TEST_PROGRAM_ID).expect("valid local test program id");
    let deployed = SolanaSettlementBackend::deploy(&validator.rpc_url, program_id)
        .await
        .expect("bind to the genesis-loaded payment-channel program");
    let token_mint = deployed.token_mint();

    let rpc =
        RpcClient::new_with_commitment(validator.rpc_url.clone(), CommitmentConfig::confirmed());
    let seed = funded_seed(&rpc, [6u8; 32]).await;

    // The canonical SPL Token program id -- deliberately spelled out
    // rather than taken from the `spl-token` crate, which is not a
    // dev-dependency of this crate's integration tests.
    let wrong_program_id = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
        .expect("the canonical SPL Token program id");
    let Err(error) = SolanaSettlementBackend::connect(
        &validator.rpc_url,
        &seed,
        wrong_program_id,
        token_mint,
        6,
    )
    .await
    else {
        panic!("a program_id naming some other executable program must refuse to connect");
    };
    let message = error.to_string();
    assert!(
        message.contains(&wrong_program_id.to_string()),
        "the failure must name the configured program id: {message}"
    );
}

#[tokio::test]
async fn connect_refuses_an_unreachable_rpc_endpoint() {
    // No validator spawned at all -- this must not hang or panic, just
    // report the RPC failure through `SettlementError::Backend`.
    let program_id = Pubkey::from_str(LOCAL_TEST_PROGRAM_ID).expect("valid local test program id");
    let seed = [5u8; 32];
    let result = SolanaSettlementBackend::connect(
        "http://127.0.0.1:1",
        &seed,
        program_id,
        Pubkey::new_unique(),
        6,
    )
    .await;
    assert!(
        result.is_err(),
        "an unreachable RPC endpoint must refuse to connect"
    );
}
