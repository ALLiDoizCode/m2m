//! `EvmSettlementBackend` held to the settlement port's contract suite,
//! unmodified, against a real, freshly-deployed `TokenNetwork` -- reached
//! through a freshly-deployed `TokenNetworkRegistry`, exactly the
//! resolution path production uses -- on a real (if disposable) chain. See
//! `tests/support/mod.rs` for how that chain is stood up.

mod support;

use std::sync::Arc;

use chrono::Duration;
use connector_settlement::contract::{assert_upholds_the_contract, ContractFixture};
use connector_settlement::{ChannelId, SettlementBackend};
use connector_settlement_evm::EvmSettlementBackend;
use connector_signer::{derive_evm_address, evm_balance_proof_digest, EvmBalanceProof};
use ethers::core::rand::thread_rng;
use ethers::providers::{Http, Provider};
use ethers::signers::{LocalWallet, Signer as EvmSigner};
use libsecp256k1::{PublicKey, SecretKey};

use support::{
    channel_id_bytes, require_anvil, sign_evm, Anvil, ANVIL_CHAIN_ID, DEPLOYER_PRIVATE_KEY,
};

/// `TokenNetwork.sol`'s own `MIN_SETTLEMENT_TIMEOUT` (one hour) plus one
/// second of margin -- the shortest challenge period this backend can
/// actually open a channel with, and so how far
/// [`advance_anvil_time`] below must move the chain's clock for
/// [`ContractFixture::advance_past_instant_settlement_timeout`] to make it
/// due.
const INSTANT_SETTLEMENT_TIMEOUT_SECONDS: i64 = 3_601;

/// Advance `anvil`'s own chain clock by `seconds` and mine a block on it,
/// so a channel's `settlement_timeout` becomes due without this test
/// sleeping in real wall-clock time (issue #576: `TokenNetwork` enforces a
/// one-hour minimum this suite cannot be asked to skip, and a real,
/// one-hour `tokio::time::sleep` in a test is not an option).
async fn advance_anvil_time(rpc_url: &str, seconds: i64) {
    let provider = Provider::<Http>::try_from(rpc_url).expect("build provider");
    let _: serde_json::Value = provider
        .request("evm_increaseTime", [seconds])
        .await
        .expect("evm_increaseTime");
    let _: serde_json::Value = provider.request("evm_mine", ()).await.expect("evm_mine");
}

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
            .expect("deploy a TokenNetwork through a fresh registry");
        let token_network_address = backend.address().to_fixed_bytes();

        // A real 20-byte EVM address the test itself holds the key for
        // (issue #576): `redeem`'s balance proof must recover to this
        // exact counterparty address on the real, signature-verifying
        // `TokenNetwork` this backend now drives.
        let counterparty_secret = SecretKey::parse(&[7u8; 32]).expect("valid secret key");
        let counterparty_public = PublicKey::from_secret_key(&counterparty_secret);
        let counterparty = derive_evm_address(&counterparty_public.serialize()).to_vec();
        // `other_counterparty` is only ever opened against, never redeemed
        // from, so it needs no key this test holds.
        let other_counterparty = LocalWallet::new(&mut thread_rng())
            .address()
            .as_bytes()
            .to_vec();

        let sign = move |channel: &ChannelId, nonce: u64, cumulative_amount: u128| {
            let proof = EvmBalanceProof {
                channel_id: channel_id_bytes(&channel.0),
                nonce,
                transferred_amount: cumulative_amount,
                locked_amount: 0,
                locks_root: [0u8; 32],
                chain_id: ANVIL_CHAIN_ID,
                token_network_address,
            };
            sign_evm(&counterparty_secret, &evm_balance_proof_digest(&proof))
        };

        let wait_rpc_url = rpc_url.clone();
        ContractFixture {
            backend: Arc::new(backend) as Arc<dyn SettlementBackend>,
            counterparty,
            other_counterparty,
            sign: Box::new(sign),
            instant_settlement_timeout: Duration::seconds(INSTANT_SETTLEMENT_TIMEOUT_SECONDS),
            advance_past_instant_settlement_timeout: Box::new(move || {
                let rpc_url = wait_rpc_url.clone();
                Box::pin(async move {
                    advance_anvil_time(&rpc_url, INSTANT_SETTLEMENT_TIMEOUT_SECONDS).await;
                })
            }),
        }
    })
    .await;
}
