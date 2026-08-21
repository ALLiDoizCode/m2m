//! The `[[pay_channels]]` money round trip, both halves, no fakes between
//! them: a payer's real [`OutboundClientLedger`] asking a payee's real
//! `POST /ilp/claim-state` over a real socket, about a channel the payee
//! holds as a **peer** channel.
//!
//! # What this is for
//!
//! `claim_state.rs`'s own unit test asserts the *answer* -- that a peer
//! channel reports the peer book's watermark. This asserts the
//! *consequence*, which is where the defect was actually measured: what the
//! payer does with that answer, over two successive packets.
//!
//! ADR 0042 item 2 covers a forwarded packet before it is sent, from a
//! channel this node holds with its next hop in both roles at once -- the
//! peer role for what arrives, the client role for what it sends, which
//! `connector_config`'s `pay_channel` module calls "the deployed shape".
//! [`OutboundClientLedger::next_claim`] takes the receiver's answer as the
//! only authority on the cumulative amount and signs `cumulative + amount`
//! at `max(nonce, issued_floor) + 1`.
//!
//! So when the receiver answers out of a book no peer claim ever reaches,
//! the payer signs the *same cumulative amount* at a fresh nonce on every
//! packet. The payee accepts each one -- a nonce did advance -- and each one
//! buys nothing, so a priced peer termination refuses every packet after the
//! first with `F06` and `advanced = 0`. Measured on `local/two-hop` as
//! `nonce 1 -> 1000` followed by `nonce 2 -> 1000`; here it is the two
//! `assert_eq!`s on `cumulative`.
//!
//! # Why it is not a chain test
//!
//! Nothing here is chain behaviour (ADR 0007's tier 3). The payee's channel
//! is a **declared** one -- `[[client_channels]]`' own shape, no deposit
//! knowable, no settlement backend -- so the whole exchange is two real
//! components and one TCP socket, and it runs in milliseconds with no
//! `anvil` in sight.

use std::net::SocketAddr;
use std::sync::Arc;

use chrono::{TimeZone, Utc};
use connector_client_edge::{
    router_with_gate, ClientChannelRegistry, ClientClaimGate, DepositFloor, EvmChannel,
};
use connector_runtime::{
    ChannelDomain, ClaimAckOutcome, ClaimSignature, ClaimStateSource, Connector, EvmDomain,
    FakeAppClient, InMemoryJournal, InProcessPeerTransport, OutboundClientLedger,
    OwnedHttpClaimState, TestClock, WireClaim,
};
use connector_signer::{derive_evm_address, LocalSigner, Signer};

/// The one channel, held by the payee as a `[[peer_channels]]` row and by
/// the payer as its `[[pay_channels]]` row -- one channel, both roles.
const CHANNEL: [u8; 32] = [0xab; 32];
const CHAIN_ID: u64 = 31_337;
const TOKEN_NETWORK: [u8; 20] = [0x42; 20];
/// What each packet forwards, and therefore what each covering claim has to
/// advance the payee's watermark by.
const AMOUNT: u64 = 1_000;
const NEXT_HOP: &str = "a-b";

fn channel_hex() -> String {
    format!("0x{}", hex::encode(CHANNEL))
}

fn domain() -> EvmDomain {
    EvmDomain {
        chain_id: CHAIN_ID,
        token_network: TOKEN_NETWORK,
    }
}

/// The payee: a node holding `CHANNEL` as a peer channel, serving its
/// client edge (and so `POST /ilp/claim-state`) on a real port.
///
/// The channel is *also* recorded in the client-edge registry, because that
/// is what the claim-state challenge's signature is verified against -- and
/// because on a deployed node it is: a peer channel is a real on-chain
/// channel this node participates in, which the registry's chain source
/// resolves for anyone who asks. Recording it here is that resolution
/// without a chain, and it is precisely what made the defect invisible: the
/// channel resolves, the challenge verifies, the answer comes back `ok` --
/// and out of the wrong book.
async fn spawn_payee(payer: &LocalSigner) -> (SocketAddr, Arc<Connector>) {
    let payer_address = derive_evm_address(&payer.public_key().expect("a secp256k1 signer"));

    let mut channels = ClientChannelRegistry::new();
    channels
        .record_evm(
            &channel_hex(),
            EvmChannel {
                counterparty: payer_address,
                chain_id: CHAIN_ID,
                token_network_address: TOKEN_NETWORK,
                deposit_floor: DepositFloor::Unknown,
            },
        )
        .expect("a 32-byte channel id");

    let connector = Arc::new(
        Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            Arc::new(TestClock::new(
                Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
            )),
        )
        .with_channel_verification_key(channel_hex(), payer_address)
        .with_channel_domain(
            channel_hex(),
            ChannelDomain {
                chain_id: CHAIN_ID,
                token_network_address: TOKEN_NETWORK,
            },
        )
        .expect("a well-formed channel id"),
    );

    let gate = ClientClaimGate::restore(channels, Arc::new(InMemoryJournal::new()))
        .expect("a fresh in-memory journal has nothing to replay");
    let signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("payee-identity"));
    let app = router_with_gate(Arc::clone(&connector), signer, None, gate);
    let server = axum::Server::bind(&"127.0.0.1:0".parse().unwrap()).serve(app.into_make_service());
    let addr = server.local_addr();
    tokio::spawn(server);
    (addr, connector)
}

#[tokio::test]
async fn successive_covered_packets_each_advance_the_payees_watermark() {
    let payer_key = LocalSigner::generate("payer-settlement");
    let (addr, payee) = spawn_payee(&payer_key).await;

    let signer: Arc<dyn Signer> = Arc::new(payer_key);
    let receiver = OwnedHttpClaimState::new(
        reqwest::Client::new(),
        format!("http://{addr}/ilp"),
        Arc::clone(&signer),
    );
    let state = tempfile::tempdir().expect("a temp dir");
    let ledger =
        OutboundClientLedger::open(state.path().join("outbound-client.log")).expect("open");

    // Two crossings. Each one asks the payee where this node's claims
    // stand and signs a claim covering exactly the amount it forwards --
    // `Connector::cover_forward`'s own sequence, with the packet left out.
    let mut cumulatives = Vec::new();
    for expected_nonce in 1..=2u64 {
        let claim = ledger
            .next_claim(
                NEXT_HOP,
                &receiver as &dyn ClaimStateSource,
                &CHANNEL,
                &domain(),
                signer.as_ref(),
                AMOUNT,
            )
            .await
            .expect("the payee answers and the ledger signs");
        assert_eq!(claim.nonce, expected_nonce);
        cumulatives.push(claim.cumulative);

        assert_eq!(
            payee.handle_peer_claim(WireClaim {
                channel_id: channel_hex(),
                nonce: claim.nonce,
                cumulative_amount: u64::try_from(claim.cumulative).expect("fits the wire"),
                signature: ClaimSignature::Evm(claim.signature),
            }),
            ClaimAckOutcome::Accepted,
            "crossing {expected_nonce}'s claim must clear the payee's peer book"
        );
    }

    // The defect measured `[1000, 1000]`: two nonces, one cumulative
    // amount, so the second packet advanced the payee's watermark by
    // nothing and a priced peer termination would refuse it `F06` with
    // `advanced = 0`.
    assert_eq!(
        cumulatives,
        vec![u128::from(AMOUNT), u128::from(2 * AMOUNT)],
        "each crossing must advance the payee's watermark by what it forwards"
    );
    assert_eq!(
        payee
            .peer_channel_watermark(&channel_hex())
            .map(|w| (w.nonce, w.cumulative_amount)),
        Some((2, 2 * AMOUNT)),
        "and the payee's own book must agree"
    );
}
