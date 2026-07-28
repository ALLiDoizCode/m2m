//! `EvmSettlementBackend` held to #458's contract suite, unmodified,
//! against a real, freshly-deployed `SettlementChannel` instance on a real
//! (if disposable) chain -- see `tests/support/mod.rs` for how that chain
//! is stood up.

mod support;

use std::sync::Arc;

use connector_settlement::contract::assert_upholds_the_contract;
use connector_settlement::SettlementBackend;
use connector_settlement_evm::EvmSettlementBackend;

use support::{require_anvil, Anvil, DEPLOYER_PRIVATE_KEY};

#[tokio::test]
async fn evm_settlement_backend_upholds_the_contract() {
    if !require_anvil() {
        return;
    }

    let anvil = Anvil::spawn().await;
    let rpc_url = anvil.rpc_url.clone();

    let token = EvmSettlementBackend::deploy_mock_token(&rpc_url, DEPLOYER_PRIVATE_KEY, 1_000_000)
        .await
        .expect("deploy mock USDC");

    assert_upholds_the_contract(|| async move {
        let backend = EvmSettlementBackend::deploy(&rpc_url, DEPLOYER_PRIVATE_KEY, token)
            .await
            .expect("deploy SettlementChannel");
        Arc::new(backend) as Arc<dyn SettlementBackend>
    })
    .await;
}
