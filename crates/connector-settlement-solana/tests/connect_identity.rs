//! Issue #630: `SolanaSettlementBackend::connect`'s fail-closed identity
//! checks. `deploy` and the contract suite already prove program-reachable
//! and mint-owned-by-SPL-Token (issue #567); this is the "fuller" check
//! `connect`'s own doc deferred to this later issue -- the configured
//! `decimals` must agree with the mint's own `decimals` field, the same
//! `#564` rule `EvmSettlementBackend::connect` already enforces for its
//! ERC-20's `decimals()`.

mod support;

use std::str::FromStr;
use std::time::Duration;

use connector_settlement_solana::SolanaSettlementBackend;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signer;

use support::{require_solana_test_validator, SolanaValidator, LOCAL_TEST_PROGRAM_ID};

/// A funded ed25519 seed [`SolanaSettlementBackend::connect`] can sign
/// transactions with -- `connect` itself submits one (`ensure_own_ata_exists`),
/// so the identity it binds to needs real lamports, exactly as a freshly
/// generated production signer would on a real cluster.
async fn funded_seed(rpc: &RpcClient, seed: [u8; 32]) -> [u8; 32] {
    let payer = solana_sdk::signer::keypair::keypair_from_seed(&seed).expect("derive keypair");
    let signature = rpc
        .request_airdrop(&payer.pubkey(), 10_000_000_000)
        .await
        .expect("airdrop");
    for _ in 0..200 {
        if rpc.confirm_transaction(&signature).await.unwrap_or(false) {
            return seed;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("airdrop did not confirm in time");
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
