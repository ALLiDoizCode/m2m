//! `SolanaSettlementBackend` held to the `SettlementBackend` port's contract
//! suite, unmodified, against a real `connector-settlement-solana-program`
//! instance loaded into a real (if disposable) validator's genesis -- see
//! `tests/support/mod.rs` for how that validator is stood up. The suite
//! requiring no changes for a second, unrelated chain is the measure of
//! success issue #428 itself names for the port being chain-agnostic.

mod support;

use std::sync::Arc;

use chrono::Duration;
use connector_settlement::contract::{assert_upholds_the_contract, ContractFixture};
use connector_settlement::SettlementBackend;
use connector_settlement_solana::SolanaSettlementBackend;
use solana_sdk::signature::{Keypair, Signer};

use support::{require_solana_test_validator, SolanaValidator};

#[tokio::test]
async fn solana_settlement_backend_upholds_the_contract() {
    if !require_solana_test_validator() {
        return;
    }

    let validator = SolanaValidator::spawn().await;
    let rpc_url = validator.rpc_url.clone();

    assert_upholds_the_contract(|| async move {
        let backend = SolanaSettlementBackend::deploy(&rpc_url)
            .await
            .expect("bind to the genesis-loaded settlement program");
        // Real 32-byte Solana pubkeys (issue #574): `redeem`'s payout is a
        // real account on this chain, not a plain ASCII peer name, so the
        // suite is handed identities this backend can actually redeem
        // against rather than a name it would have to hash down to one.
        let counterparty = Keypair::new().pubkey().to_bytes().to_vec();
        let other_counterparty = Keypair::new().pubkey().to_bytes().to_vec();
        ContractFixture {
            backend: Arc::new(backend) as Arc<dyn SettlementBackend>,
            counterparty,
            other_counterparty,
            // The deployed settlement program does not verify a claim's
            // signature (issue #576's sibling gap, tracked separately for
            // Solana), so any bytes suffice here.
            sign: Box::new(
                |_channel: &connector_settlement::ChannelId,
                 _nonce: u64,
                 _cumulative_amount: u128| { vec![0u8] },
            ),
            // No minimum enforced by the deployed program, so a
            // zero-length challenge period is already due the instant the
            // channel closes -- no advancing needed.
            instant_settlement_timeout: Duration::zero(),
            advance_past_instant_settlement_timeout: Box::new(|| Box::pin(async {})),
        }
    })
    .await;
}
