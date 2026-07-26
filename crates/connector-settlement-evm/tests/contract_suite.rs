//! `EvmSettlementBackend` held to #458's contract suite, unmodified,
//! against a real, freshly-deployed `SettlementChannel` instance on a real
//! (if disposable) chain -- see `tests/support/mod.rs` for how that chain
//! is stood up.

mod support;

use std::sync::Arc;

use connector_settlement::contract::assert_upholds_the_contract;
use connector_settlement::SettlementBackend;
use connector_settlement_evm::EvmSettlementBackend;

use support::{anvil_available, Anvil, DEPLOYER_PRIVATE_KEY};

#[tokio::test]
async fn evm_settlement_backend_upholds_the_contract() {
    if !anvil_available() {
        eprintln!("skipping: `anvil` not found on PATH (install via https://getfoundry.sh)");
        return;
    }

    let anvil = Anvil::spawn().await;
    let rpc_url = anvil.rpc_url.clone();

    assert_upholds_the_contract(|| async move {
        let backend = EvmSettlementBackend::deploy(&rpc_url, DEPLOYER_PRIVATE_KEY)
            .await
            .expect("deploy SettlementChannel");
        Arc::new(backend) as Arc<dyn SettlementBackend>
    })
    .await;
}
