//! `SolanaSettlementBackend` held to the `SettlementBackend` port's contract
//! suite, unmodified, against a real `connector-settlement-solana-program`
//! instance loaded into a real (if disposable) validator's genesis -- see
//! `tests/support/mod.rs` for how that validator is stood up. The suite
//! requiring no changes for a second, unrelated chain is the measure of
//! success issue #428 itself names for the port being chain-agnostic.

mod support;

use std::sync::Arc;

use connector_settlement::contract::assert_upholds_the_contract;
use connector_settlement::SettlementBackend;
use connector_settlement_solana::SolanaSettlementBackend;

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
        Arc::new(backend) as Arc<dyn SettlementBackend>
    })
    .await;
}
