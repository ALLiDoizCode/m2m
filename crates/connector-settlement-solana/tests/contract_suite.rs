//! `SolanaSettlementBackend` held to the `SettlementBackend` port's
//! contract suite, unmodified, against a real `packages/solana-program`
//! instance loaded into a real (if disposable) validator's genesis -- see
//! `connector_settlement_solana::test_support` for how that validator is stood up. The suite
//! requiring no changes for the deployed program's own, very different
//! wire (SPL-token PDAs and an Ed25519-precompile balance proof, in place
//! of the old crate's native-SOL, unverified one) is the measure of
//! success issue #567 itself names for the port being chain-agnostic.

use std::str::FromStr;
use std::sync::Arc;

use chrono::Duration;
use connector_settlement::contract::{assert_upholds_the_contract, ContractFixture};
use connector_settlement::{ChannelId, SettlementBackend};
use connector_settlement_solana::SolanaSettlementBackend;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

use connector_settlement_solana::test_support::{
    require_solana_test_validator, SolanaValidator, LOCAL_TEST_PROGRAM_ID,
};

#[tokio::test]
async fn solana_settlement_backend_upholds_the_contract() {
    if !require_solana_test_validator() {
        return;
    }

    let validator = SolanaValidator::spawn().await;
    let rpc_url = validator.rpc_url.clone();
    let program_id = Pubkey::from_str(LOCAL_TEST_PROGRAM_ID).expect("valid local test program id");

    assert_upholds_the_contract(|| async move {
        let backend = SolanaSettlementBackend::deploy(&rpc_url, program_id)
            .await
            .expect("bind to the genesis-loaded payment-channel program");
        // The real counterparty identity `deploy` privately holds a key
        // for (issue #567): `redeem`'s Ed25519 precompile check must
        // recover to this exact counterparty pubkey on the real,
        // signature-verifying deployed program, and `fund` must sign a
        // real on-chain Deposit as this same participant.
        let counterparty = backend
            .test_counterparty_pubkey()
            .expect("deploy() holds a counterparty key");
        // The instant-settlement channel gets its own key-held identity:
        // the deployed program holds one live channel per (pair, mint), so
        // it cannot reuse `counterparty` (whose channel is still Closed in
        // its challenge window when it opens), and the suite funds it, so
        // its counterparty must be one this backend can sign a real
        // on-chain Deposit for.
        let instant_counterparty = backend
            .test_instant_counterparty_pubkey()
            .expect("deploy() holds a second counterparty key");
        // `other_counterparty` is only ever opened against, never funded
        // or redeemed from, so it needs no key this test holds.
        let other_counterparty = Keypair::new().pubkey().to_bytes().to_vec();

        let backend = Arc::new(backend);
        let sign_backend = Arc::clone(&backend);
        let sign = move |channel: &ChannelId, nonce: u64, cumulative_amount: u128| {
            sign_backend
                .test_sign_claim(channel, nonce, cumulative_amount)
                .expect("deploy() holds a counterparty key to sign with")
        };

        ContractFixture {
            backend: backend as Arc<dyn SettlementBackend>,
            counterparty,
            other_counterparty,
            instant_counterparty,
            sign: Box::new(sign),
            // No protocol-level minimum challenge period is enforced by
            // the deployed program (unlike `TokenNetwork`'s one-hour
            // `MIN_SETTLEMENT_TIMEOUT`), so a zero-length one is already
            // due the instant the channel closes -- no advancing needed.
            instant_settlement_timeout: Duration::zero(),
            advance_past_instant_settlement_timeout: Box::new(|| Box::pin(async {})),
        }
    })
    .await;
}
